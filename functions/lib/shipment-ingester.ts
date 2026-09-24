import { shippableItems, stripOrderPrefix } from './order-mapper';
import { ShipStationSettings, appId } from './settings';
import { ShipStationShipment, ShipStationShipmentItem, errorText } from './shipstation';
import { readSyncState, recordSyncState } from './sync-state';

/** Keeps one webhook delivery inside the function's time budget. */
export const MAX_SHIPMENTS_PER_DELIVERY = 25;

const ORDER_EXPAND = ['items.product', 'items.variant'];

export type IngestAction = 'created' | 'canceled' | 'duplicate' | 'skipped' | 'no_order' | 'error';

export interface IngestDetail {
  shipmentId: number | null;
  action: IngestAction;
  orderId?: string;
  shipmentRecordId?: string;
  message?: string;
}

export interface IngestSummary {
  created: number;
  canceled: number;
  duplicates: number;
  skipped: number;
  failed: number;
  details: IngestDetail[];
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

async function resolveOrder(
  req: SwellRequest,
  settings: ShipStationSettings,
  shipment: ShipStationShipment,
): Promise<Record<string, any> | null> {
  const key = str(shipment.orderKey);
  if (key && /^[0-9a-f]{24}$/i.test(key)) {
    const order = await req.swell.get('/orders/{id}', {
      id: key,
      expand: ORDER_EXPAND,
    });
    if (order) {
      return order as Record<string, any>;
    }
  }

  const number = str(shipment.orderNumber);
  if (number) {
    // `number` is the orders model's secondary lookup field, so it resolves by path.
    const order = await req.swell.get('/orders/{id}', {
      id: stripOrderPrefix(number, settings.order_prefix),
      expand: ORDER_EXPAND,
    });
    if (order) {
      return order as Record<string, any>;
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

  const byShipStationId = new Map<number, Record<string, any>>();
  for (const record of existing?.results ?? []) {
    const id = appShipmentId(req, record);
    if (id !== null) {
      byShipStationId.set(id, record);
    }
  }

  const context: OrderContext = {
    order,
    byShipStationId,
    created: 0,
    ...indexOrderItems(order),
  };
  contexts.set(order.id, context);
  return context;
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

async function ingestOne(
  req: SwellRequest,
  settings: ShipStationSettings,
  shipment: ShipStationShipment,
  contexts: Map<string, OrderContext>,
): Promise<IngestDetail> {
  const shipmentId = Number.isFinite(Number(shipment.shipmentId))
    ? Number(shipment.shipmentId)
    : null;

  const order = await resolveOrder(req, settings, shipment);
  if (!order) {
    return {
      shipmentId,
      action: 'no_order',
      message: `No Swell order matches orderKey "${shipment.orderKey ?? ''}" or orderNumber "${shipment.orderNumber ?? ''}".`,
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
 */
export async function ingestShipments(
  req: SwellRequest,
  settings: ShipStationSettings,
  shipments: ShipStationShipment[],
): Promise<IngestSummary> {
  const summary: IngestSummary = {
    created: 0,
    canceled: 0,
    duplicates: 0,
    skipped: 0,
    failed: 0,
    details: [],
  };

  const batch = shipments.slice(0, MAX_SHIPMENTS_PER_DELIVERY);
  if (shipments.length > batch.length) {
    console.warn(
      `ShipStation: delivery contained ${shipments.length} shipments; processing the first ${batch.length}. The remainder will arrive with the next notification.`,
    );
  }

  const contexts = new Map<string, OrderContext>();

  for (const shipment of batch) {
    let detail: IngestDetail;
    try {
      detail = await ingestOne(req, settings, shipment, contexts);
    } catch (err) {
      detail = {
        shipmentId: Number(shipment?.shipmentId) || null,
        action: 'error',
        message: errorText(err),
      };
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
      default:
        summary.failed += 1;
        console.error(
          `ShipStation: could not record shipment ${detail.shipmentId ?? '(no id)'}: ${detail.message}`,
        );
    }
  }

  const now = new Date().toISOString();
  const failureByOrder = new Map<string, string>();
  for (const detail of summary.details) {
    if (detail.action === 'error' && detail.orderId && detail.message) {
      failureByOrder.set(detail.orderId, detail.message);
    }
  }

  for (const [orderId, context] of contexts) {
    const state = readSyncState(req, context.order);
    await recordSyncState(req, orderId, {
      last_webhook_at: now,
      shipments_count: context.byShipStationId.size || (state.shipments_count ?? 0),
      last_error: failureByOrder.get(orderId) ?? state.last_error ?? null,
    });
  }

  return summary;
}
