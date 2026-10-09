import { shippableItems, stripOrderPrefix } from './order-mapper';
import {
  SwellEnvironment,
  environmentName,
  parseOrderKey,
  swellEnvironment,
} from './environment';
import { ShipStationSettings, appId } from './settings';
import { ShipStationShipment, ShipStationShipmentItem, errorText } from './shipstation';
import { readSyncState, recordSyncState } from './sync-state';

/**
 * Default time to spend recording shipments, measured from the start of the call. Work
 * left when it runs out is reported as deferred, and the caller asks ShipStation to
 * redeliver; shipments already recorded are recognised as duplicates next time.
 */
export const INGEST_BUDGET_MS = 6000;

/** Orders looked up per `/orders` call when a delivery is read in bulk. */
const ORDER_LOOKUP_CHUNK = 50;

/** Most shipments one `/shipments` call returns. */
const SHIPMENT_LOOKUP_LIMIT = 1000;

const ORDER_EXPAND = ['items.product', 'items.variant'];

export type IngestAction =
  | 'created'
  | 'canceled'
  | 'duplicate'
  | 'skipped'
  | 'unmatched'
  | 'deferred'
  | 'error';

export interface IngestDetail {
  shipmentId: number | null;
  action: IngestAction;
  orderId?: string;
  shipmentRecordId?: string;
  message?: string;
  /** For errors: whether trying the same shipment again could succeed. */
  retryable?: boolean;
}

export interface IngestSummary {
  created: number;
  canceled: number;
  duplicates: number;
  skipped: number;
  /** Shipments for orders that are not this environment's: acknowledged, not failures. */
  unmatched: number;
  /** Not reached before the time budget ran out. */
  deferred: number;
  failed: number;
  /** Something is left that a redelivery would record: deferred work or a transient error. */
  retry: boolean;
  details: IngestDetail[];
}

export interface IngestOptions {
  /** Epoch ms after which no new shipment is started. */
  deadline?: number;
}

interface ShipmentItemInput {
  order_item_id: string;
  product_id: string;
  variant_id?: string;
  quantity: number;
}

export interface OrderContext {
  order: Record<string, any>;
  /** Swell shipments already recorded for this order, keyed by ShipStation shipmentId. */
  byShipStationId: Map<number, Record<string, any>>;
  itemsById: Map<string, Record<string, any>>;
  itemsBySku: Map<string, Record<string, any>>;
  /** Quantity per order item still awaiting fulfillment. */
  remaining: Map<string, number>;
  created: number;
}

const CARRIER_NAMES: Record<string, string> = {
  apc: 'APC Postal Logistics',
  asendia: 'Asendia',
  australia_post: 'Australia Post',
  canada_post: 'Canada Post',
  dhl: 'DHL',
  dhl_ecommerce: 'DHL eCommerce',
  dhl_express: 'DHL Express',
  dhl_global_mail: 'DHL Global Mail',
  endicia: 'USPS',
  fedex: 'FedEx',
  globegistics: 'Globegistics',
  imex: 'IMEX',
  newgistics: 'Newgistics',
  ontrac: 'OnTrac',
  purolator_ca: 'Purolator',
  royal_mail: 'Royal Mail',
  stamps_com: 'USPS',
  ups: 'UPS',
  usps: 'USPS',
};

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function toInt(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

// Capitalises after spaces and after digits, so "fedex_2day" reads "FedEx 2Day".
function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/(^|[\s\d])([a-z])/g, (_match, before: string, letter: string) => {
      return before + letter.toUpperCase();
    });
}

export function carrierName(code: string): string {
  return CARRIER_NAMES[code.toLowerCase()] ?? titleCase(code);
}

export function serviceName(code: string): string {
  const parts = code.toLowerCase().split('_');
  const carrier = CARRIER_NAMES[parts[0]];
  if (carrier && parts.length > 1) {
    return `${carrier} ${titleCase(parts.slice(1).join('_'))}`;
  }
  return titleCase(code);
}

function appShipmentId(req: SwellRequest, record: unknown): number | null {
  const value = (record as Record<string, any>)?.$app?.[appId(req)]?.shipment_id;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A missing record comes back empty or as a "not found" error, depending on the path. */
function isNotFound(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  return status === 404 || /not found/i.test(errorText(err));
}

async function getOrder(req: SwellRequest, id: string): Promise<Record<string, any> | null> {
  try {
    const order = (await req.swell.get('/orders/{id}', {
      id,
      expand: ORDER_EXPAND,
    })) as Record<string, any> | null;
    return order?.id ? order : null;
  } catch (err) {
    if (isNotFound(err)) {
      return null;
    }
    throw err;
  }
}

/**
 * Finds the Swell order a ShipStation shipment belongs to, in this environment only.
 *
 * The order key decides it. A key another Swell environment made (`test:<id>` seen from
 * live, or a bare id seen from test) is never this environment's order, whatever its
 * number says. Matching on the order number alone is only trusted when ShipStation's own
 * order id agrees with the one recorded when this app pushed the order: one ShipStation
 * account often holds orders from several channels, and test and live number their
 * orders independently, so the same number can easily belong to someone else.
 */
async function resolveOrder(
  req: SwellRequest,
  settings: ShipStationSettings,
  shipment: ShipStationShipment,
  env: SwellEnvironment,
  contexts: Map<string, OrderContext>,
): Promise<Record<string, any> | null> {
  const key = parseOrderKey(shipment.orderKey);
  if (key) {
    if (key.environment.toLowerCase() !== environmentName(env).toLowerCase()) {
      return null;
    }
    const order = contexts.get(key.orderId)?.order ?? (await getOrder(req, key.orderId));
    if (order) {
      return order;
    }
  }

  const number = str(shipment.orderNumber);
  const shipstationOrderId = Number(shipment.orderId);
  if (number && shipment.orderId != null && Number.isFinite(shipstationOrderId)) {
    // `number` is the orders model's secondary lookup field, so it resolves by path.
    const order = await getOrder(req, stripOrderPrefix(number, settings.order_prefix));
    if (order && Number(readSyncState(req, order).shipstation_order_id) === shipstationOrderId) {
      return order;
    }
  }

  return null;
}

/**
 * Indexes an order's shippable line items by id and SKU, and records how much of each is
 * still awaiting fulfillment.
 */
export function indexOrderItems(order: Record<string, any>): {
  itemsById: Map<string, Record<string, any>>;
  itemsBySku: Map<string, Record<string, any>>;
  remaining: Map<string, number>;
} {
  const itemsById = new Map<string, Record<string, any>>();
  const itemsBySku = new Map<string, Record<string, any>>();
  const remaining = new Map<string, number>();

  for (const item of shippableItems(order)) {
    const id = String(item.id);
    itemsById.set(id, item);
    remaining.set(id, Math.max(0, toInt(item.quantity_deliverable)));
    const sku = str(item.variant?.sku) ?? str(item.product?.sku);
    if (sku && !itemsBySku.has(sku.toLowerCase())) {
      itemsBySku.set(sku.toLowerCase(), item);
    }
  }

  return { itemsById, itemsBySku, remaining };
}

function newContext(
  req: SwellRequest,
  order: Record<string, any>,
  shipments: Array<Record<string, any>>,
): OrderContext {
  const byShipStationId = new Map<number, Record<string, any>>();
  for (const record of shipments) {
    const id = appShipmentId(req, record);
    if (id !== null) {
      byShipStationId.set(id, record);
    }
  }
  return { order, byShipStationId, created: 0, ...indexOrderItems(order) };
}

async function orderContext(
  req: SwellRequest,
  order: Record<string, any>,
  contexts: Map<string, OrderContext>,
): Promise<OrderContext> {
  const cached = contexts.get(order.id);
  if (cached) {
    return cached;
  }

  const existing = (await req.swell.get('/shipments', {
    order_id: order.id,
    limit: 100,
  })) as { results?: Array<Record<string, any>> } | null;

  const context = newContext(req, order, existing?.results ?? []);
  contexts.set(order.id, context);
  return context;
}

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}

/**
 * Reads every order a delivery refers to, and the shipments already recorded on them, in
 * a few bulk calls instead of two per order. That keeps a redelivered notification cheap:
 * the shipments recorded the first time are recognised as duplicates without a round trip
 * each, so each redelivery gets further through a large batch than the last.
 *
 * Best effort: anything not found here is looked up one order at a time as before.
 */
async function prefetchContexts(
  req: SwellRequest,
  shipments: ShipStationShipment[],
  env: SwellEnvironment,
  contexts: Map<string, OrderContext>,
): Promise<void> {
  const ids = new Set<string>();
  for (const shipment of shipments) {
    const key = parseOrderKey(shipment.orderKey);
    if (key && key.environment.toLowerCase() === environmentName(env).toLowerCase()) {
      ids.add(key.orderId);
    }
  }
  if (ids.size < 2) {
    return;
  }

  try {
    for (const chunk of chunks([...ids], ORDER_LOOKUP_CHUNK)) {
      const orders = (await req.swell.get('/orders', {
        id: { $in: chunk },
        expand: ORDER_EXPAND,
        limit: chunk.length,
      })) as { results?: Array<Record<string, any>> } | null;
      const found = (orders?.results ?? []).filter((order) => order?.id);
      if (found.length === 0) {
        continue;
      }

      const recorded = (await req.swell.get('/shipments', {
        order_id: { $in: found.map((order) => order.id) },
        limit: SHIPMENT_LOOKUP_LIMIT,
      })) as { results?: Array<Record<string, any>>; count?: number } | null;
      const results = recorded?.results ?? [];
      // A truncated answer could hide a duplicate; leave those orders to the lookup that
      // reads them one at a time.
      if (typeof recorded?.count === 'number' && recorded.count > results.length) {
        continue;
      }

      const byOrder = new Map<string, Array<Record<string, any>>>();
      for (const record of results) {
        const orderId = String(record?.order_id ?? '');
        byOrder.set(orderId, [...(byOrder.get(orderId) ?? []), record]);
      }
      for (const order of found) {
        if (!contexts.has(order.id)) {
          contexts.set(order.id, newContext(req, order, byOrder.get(order.id) ?? []));
        }
      }
    }
  } catch (err) {
    console.warn(`ShipStation: could not read the delivery's orders in bulk: ${errorText(err)}`);
  }
}

function matchOrderItem(
  context: OrderContext,
  line: ShipStationShipmentItem,
): Record<string, any> | null {
  const key = str(line.lineItemKey);
  if (key) {
    const byId = context.itemsById.get(key);
    if (byId) {
      return byId;
    }
  }
  const sku = str(line.sku);
  if (sku) {
    const bySku = context.itemsBySku.get(sku.toLowerCase());
    if (bySku) {
      return bySku;
    }
  }
  return null;
}

function toShipmentItem(orderItem: Record<string, any>, quantity: number): ShipmentItemInput {
  const item: ShipmentItemInput = {
    order_item_id: String(orderItem.id),
    product_id: String(orderItem.product_id),
    quantity,
  };
  if (orderItem.variant_id) {
    item.variant_id = String(orderItem.variant_id);
  }
  return item;
}

/**
 * Works out which Swell line items this ShipStation shipment covers. Quantities are
 * capped at what is still awaiting fulfillment so a replayed or overlapping shipment can
 * never push an order past fully delivered.
 */
export function buildShipmentItems(
  context: OrderContext,
  shipment: ShipStationShipment,
): ShipmentItemInput[] {
  const working = new Map(context.remaining);
  const items: ShipmentItemInput[] = [];
  const lines = Array.isArray(shipment.shipmentItems) ? shipment.shipmentItems : [];

  if (lines.length > 0) {
    for (const line of lines) {
      const orderItem = matchOrderItem(context, line);
      if (!orderItem) {
        console.warn(
          `ShipStation: shipment ${shipment.shipmentId} lists an item that is not on the order (lineItemKey=${line.lineItemKey ?? ''}, sku=${line.sku ?? ''})`,
        );
        continue;
      }
      const id = String(orderItem.id);
      const left = working.get(id) ?? 0;
      const quantity = Math.min(toInt(line.quantity) || left, left);
      if (quantity <= 0) {
        continue;
      }
      working.set(id, left - quantity);
      items.push(toShipmentItem(orderItem, quantity));
    }
    return items;
  }

  // A notification without item detail means everything still outstanding has shipped.
  for (const [id, left] of working) {
    const orderItem = context.itemsById.get(id);
    if (orderItem && left > 0) {
      items.push(toShipmentItem(orderItem, left));
    }
  }
  return items;
}

function buildDestination(
  shipment: ShipStationShipment,
  order: Record<string, any>,
): Record<string, unknown> | null {
  const shipTo = (shipment.shipTo ?? {}) as Record<string, any>;
  const fallback = (order.shipping ?? {}) as Record<string, any>;

  const country = str(shipTo.country) ?? str(fallback.country);
  const address1 = str(shipTo.street1) ?? str(fallback.address1);
  const name =
    str(shipTo.name) ??
    str(fallback.name) ??
    [fallback.first_name, fallback.last_name].filter(Boolean).join(' ') ??
    undefined;

  if (!address1 || !country || country.length !== 2) {
    return null;
  }

  return {
    name: name || 'Customer',
    address1,
    address2: str(shipTo.street2) ?? str(fallback.address2) ?? null,
    city: str(shipTo.city) ?? str(fallback.city) ?? null,
    state: str(shipTo.state) ?? str(fallback.state) ?? null,
    zip: str(shipTo.postalCode) ?? str(fallback.zip) ?? null,
    country,
    phone: str(shipTo.phone) ?? str(fallback.phone) ?? null,
  };
}

/**
 * Puts a canceled shipment's quantities back into what the order still has to ship, so a
 * replacement label later in the same delivery is matched instead of skipped. The order
 * was read before the void, when those items still counted as delivered.
 */
function restoreQuantities(context: OrderContext, shipment: Record<string, any>): void {
  const items = Array.isArray(shipment.items) ? shipment.items : [];
  for (const item of items) {
    const id = String(item?.order_item_id ?? '');
    const orderItem = context.itemsById.get(id);
    if (!orderItem) {
      continue;
    }
    const left = context.remaining.get(id) ?? 0;
    const cap = Math.max(0, toInt(orderItem.quantity_total));
    context.remaining.set(id, Math.min(cap, left + Math.max(0, toInt(item.quantity))));
  }
}

/** Swell errors carry the HTTP status; 4xx means the same request would fail again. */
function isTransient(err: unknown): boolean {
  const status = Number((err as { status?: unknown })?.status);
  return !Number.isFinite(status) || status === 0 || status === 429 || status >= 500;
}

async function ingestOne(
  req: SwellRequest,
  settings: ShipStationSettings,
  shipment: ShipStationShipment,
  contexts: Map<string, OrderContext>,
  env: SwellEnvironment,
): Promise<IngestDetail> {
  const shipmentId = Number.isFinite(Number(shipment.shipmentId))
    ? Number(shipment.shipmentId)
    : null;

  const order = await resolveOrder(req, settings, shipment, env, contexts);
  if (!order) {
    return {
      shipmentId,
      action: 'unmatched',
      message: `No order in this Swell environment matches orderKey "${shipment.orderKey ?? ''}" / orderNumber "${shipment.orderNumber ?? ''}"; it belongs to another sales channel or environment.`,
    };
  }

  const context = await orderContext(req, order, contexts);
  const existing = shipmentId !== null ? context.byShipStationId.get(shipmentId) : undefined;

  if (shipment.voided) {
    if (!existing) {
      return {
        shipmentId,
        action: 'skipped',
        orderId: order.id,
        message: 'Voided label has no matching Swell shipment.',
      };
    }
    if (existing.canceled) {
      return {
        shipmentId,
        action: 'duplicate',
        orderId: order.id,
        message: 'Shipment is already canceled in Swell.',
      };
    }
    await req.swell.put(`/shipments/${existing.id}`, {
      canceled: true,
      ...req.appValues({ voided: true }),
    });
    existing.canceled = true;
    restoreQuantities(context, existing);
    return {
      shipmentId,
      action: 'canceled',
      orderId: order.id,
      shipmentRecordId: existing.id,
    };
  }

  if (existing) {
    return {
      shipmentId,
      action: 'duplicate',
      orderId: order.id,
      shipmentRecordId: existing.id,
      message: 'Shipment was already recorded in Swell.',
    };
  }

  const items = buildShipmentItems(context, shipment);
  if (items.length === 0) {
    return {
      shipmentId,
      action: 'skipped',
      orderId: order.id,
      message: 'No outstanding order items matched this shipment.',
    };
  }

  const destination = buildDestination(shipment, order);
  if (!destination) {
    return {
      shipmentId,
      action: 'error',
      orderId: order.id,
      message: 'Shipment has no usable destination address.',
      retryable: false,
    };
  }

  const body: Record<string, unknown> = {
    order_id: order.id,
    items,
    destination,
    ...req.appValues({
      shipment_id: shipmentId,
      batch_number: str(shipment.batchNumber) ?? null,
      voided: false,
    }),
  };

  const carrier = str(shipment.carrierCode);
  if (carrier) {
    body.carrier_name = carrierName(carrier);
  }
  const service = str(shipment.serviceCode);
  if (service) {
    body.service_name = serviceName(service);
  }
  const tracking = str(shipment.trackingNumber);
  if (tracking) {
    body.tracking_code = tracking;
  }

  const created = (await req.swell.post('/shipments', body)) as Record<string, any>;

  // Without the dedupe key a redelivery would create a second shipment, so make sure it
  // actually persisted rather than assuming create-time $app writes are supported.
  if (shipmentId !== null && appShipmentId(req, created) !== shipmentId) {
    await req.swell.put(`/shipments/${created.id}`, req.appValues({ shipment_id: shipmentId }));
  }

  if (shipmentId !== null) {
    context.byShipStationId.set(shipmentId, created);
  }
  context.created += 1;
  for (const item of items) {
    const left = context.remaining.get(item.order_item_id) ?? 0;
    context.remaining.set(item.order_item_id, Math.max(0, left - item.quantity));
  }

  console.log(
    `ShipStation: recorded shipment ${shipmentId ?? '(no id)'} on order ${order.number} with ${items.length} item(s), tracking ${tracking ?? 'none'}`,
  );

  return {
    shipmentId,
    action: 'created',
    orderId: order.id,
    shipmentRecordId: created?.id,
  };
}

/**
 * Turns ShipStation shipments into Swell shipment records. Partial fulfillment needs no
 * special handling: the platform recomputes the order's delivered status from the item
 * quantities on each shipment.
 *
 * Every shipment in the delivery is considered; none is dropped. Voided labels go first,
 * so a void and its replacement in the same delivery free up and reuse the same items.
 * If the time budget runs out, the rest are reported as `deferred` and `retry` is set:
 * a redelivery recognises what was already recorded and carries on from there.
 */
export async function ingestShipments(
  req: SwellRequest,
  settings: ShipStationSettings,
  shipments: ShipStationShipment[],
  options: IngestOptions = {},
): Promise<IngestSummary> {
  const deadline = options.deadline ?? Date.now() + INGEST_BUDGET_MS;
  const summary: IngestSummary = {
    created: 0,
    canceled: 0,
    duplicates: 0,
    skipped: 0,
    unmatched: 0,
    deferred: 0,
    failed: 0,
    retry: false,
    details: [],
  };
  const env = swellEnvironment(req);

  const ordered = [
    ...shipments.filter((shipment) => shipment?.voided),
    ...shipments.filter((shipment) => !shipment?.voided),
  ];

  const contexts = new Map<string, OrderContext>();
  await prefetchContexts(req, ordered, env, contexts);

  for (const shipment of ordered) {
    let detail: IngestDetail;
    if (Date.now() >= deadline) {
      detail = {
        shipmentId: Number(shipment?.shipmentId) || null,
        action: 'deferred',
        message: 'Not reached in this delivery; recorded when ShipStation redelivers it.',
      };
    } else {
      try {
        detail = await ingestOne(req, settings, shipment, contexts, env);
      } catch (err) {
        detail = {
          shipmentId: Number(shipment?.shipmentId) || null,
          action: 'error',
          message: errorText(err),
          retryable: isTransient(err),
        };
      }
    }

    summary.details.push(detail);
    switch (detail.action) {
      case 'created':
        summary.created += 1;
        break;
      case 'canceled':
        summary.canceled += 1;
        break;
      case 'duplicate':
        summary.duplicates += 1;
        break;
      case 'skipped':
        summary.skipped += 1;
        break;
      case 'unmatched':
        // ShipStation notifies about every shipment on the account (or store), so other
        // channels' labels land here too. Not ours to record, and not worth a retry.
        summary.unmatched += 1;
        console.log(`ShipStation: ignored shipment ${detail.shipmentId ?? '(no id)'}: ${detail.message}`);
        break;
      case 'deferred':
        summary.deferred += 1;
        summary.retry = true;
        break;
      default:
        summary.failed += 1;
        if (detail.retryable !== false) {
          summary.retry = true;
        }
        console.error(
          `ShipStation: could not record shipment ${detail.shipmentId ?? '(no id)'}: ${detail.message}`,
        );
    }
  }

  if (summary.deferred > 0) {
    console.warn(
      `ShipStation: ran out of time with ${summary.deferred} of ${shipments.length} shipment(s) still to check; asking ShipStation to redeliver.`,
    );
  }

  const now = new Date().toISOString();
  const failureByOrder = new Map<string, string>();
  for (const detail of summary.details) {
    if (detail.action === 'error' && detail.orderId && detail.message) {
      failureByOrder.set(detail.orderId, detail.message);
    }
  }

  // Only orders this delivery actually touched; prefetched orders it never reached are
  // left alone.
  const touched = new Set(
    summary.details
      .filter((detail) => detail.orderId && detail.action !== 'deferred')
      .map((detail) => detail.orderId as string),
  );
  for (const [orderId, context] of contexts) {
    if (!touched.has(orderId)) {
      continue;
    }
    const state = readSyncState(req, context.order);
    const active = [...context.byShipStationId.values()].filter((record) => !record?.canceled);
    await recordSyncState(req, orderId, {
      last_webhook_at: now,
      shipments_count: active.length,
      last_error: failureByOrder.get(orderId) ?? state.last_error ?? null,
    });
  }

  return summary;
}
