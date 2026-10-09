import { orderKeyFor, swellEnvironment } from './environment';
import { mapOrder, shippableItems } from './order-mapper';
import { ShipStationSettings, hasCredentials } from './settings';
import {
  PROBE_TIMEOUT_MS,
  ShipStationClient,
  ShipStationError,
  ShipStationOrder,
  ShipStationOrderStatus,
  errorText,
} from './shipstation';
import { SyncState, SyncStatus, readSyncState, recordSyncState } from './sync-state';

export type PushAction =
  | 'pushed'
  | 'skipped_not_configured'
  | 'skipped_never_pushed'
  | 'skipped_already_shipped'
  | 'skipped_no_items'
  | 'skipped_unchanged'
  | 'error';

export interface PushResult {
  orderId: string;
  ok: boolean;
  action: PushAction;
  message?: string;
  /** Only meaningful when ok is false: whether the platform should redeliver the event. */
  retryable?: boolean;
  shipstationOrderId?: number;
}

export interface PushOptions {
  /** Update and cancel paths only touch orders ShipStation already knows about. */
  requireExisting?: boolean;
  /** Check the remote order first: ShipStation refuses edits to shipped/cancelled orders. */
  guardShipped?: boolean;
  statusOverride?: ShipStationOrderStatus;
  successStatus?: SyncStatus;
  /**
   * Skip the push when the payload is identical to the last one sent. For pushes caused
   * by incidental order updates, never for an explicit re-sync.
   */
  skipIfUnchanged?: boolean;
}

const ORDER_EXPAND = ['account', 'items.product', 'items.variant'];

const SHIPSTATION_FINAL_STATUSES = ['shipped', 'cancelled'];

export async function getWeightUnit(req: SwellRequest): Promise<string | undefined> {
  try {
    const shipmentSettings = await req.swell.get('/settings/shipments');
    const unit = shipmentSettings?.weight_unit;
    return typeof unit === 'string' ? unit : undefined;
  } catch (err) {
    console.warn(`ShipStation: could not read the store weight unit: ${errorText(err)}`);
    return undefined;
  }
}

export async function loadOrder(
  req: SwellRequest,
  orderId: string,
): Promise<Record<string, any> | null> {
  return (await req.swell.get('/orders/{id}', {
    id: orderId,
    expand: ORDER_EXPAND,
  })) as Record<string, any> | null;
}

/**
 * Reads the order's status in ShipStation. A failed probe is not fatal: ShipStation
 * rejects the update itself if the order has already shipped.
 */
async function remoteStatus(
  client: ShipStationClient,
  state: SyncState,
  orderKey: string,
): Promise<string | null> {
  try {
    if (state.shipstation_order_id) {
      const order = await client.getOrder(state.shipstation_order_id, PROBE_TIMEOUT_MS);
      return order?.orderStatus ?? null;
    }
    if (state.shipstation_order_number) {
      // Order numbers are not unique in ShipStation (other channels, other environments),
      // so only an order with this order's key counts.
      const order = await client.findOrderByNumber(
        state.shipstation_order_number,
        PROBE_TIMEOUT_MS,
        orderKey,
      );
      return order?.orderStatus ?? null;
    }
  } catch (err) {
    console.warn(`ShipStation: could not read the remote order status: ${errorText(err)}`);
  }
  return null;
}

/**
 * Creates or replaces an order in ShipStation and records the outcome on the Swell order.
 * Never throws for an expected failure — callers decide whether a failure should be
 * retried by the platform.
 */
export async function pushOrder(
  req: SwellRequest,
  settings: ShipStationSettings,
  orderId: string,
  options: PushOptions = {},
): Promise<PushResult> {
  if (!hasCredentials(settings)) {
    return {
      orderId,
      ok: false,
      action: 'skipped_not_configured',
      message: 'ShipStation API key and secret are not set in app settings.',
      // Retrying cannot fix missing credentials; record it once and stop.
      retryable: false,
    };
  }

  const order = await loadOrder(req, orderId);
  if (!order) {
    return { orderId, ok: false, action: 'error', message: `Order ${orderId} was not found.` };
  }

  const state = readSyncState(req, order);

  if (options.requireExisting && !state.order_key) {
    return {
      orderId,
      ok: true,
      action: 'skipped_never_pushed',
      message: 'Order has not been pushed to ShipStation yet.',
    };
  }

  const client = new ShipStationClient(settings.api_key, settings.api_secret);
  const orderKey = orderKeyFor(swellEnvironment(req), String(order.id));

  // Only worth a round trip when some item actually carries a weight; the unit is
  // meaningless otherwise and the call competes for the function's time budget.
  const needsWeightUnit = shippableItems(order).some((item) => Number(item.shipment_weight) > 0);

  let payload;
  try {
    payload = mapOrder(order, {
      orderPrefix: settings.order_prefix,
      storeId: settings.store_id,
      weightUnit: needsWeightUnit ? await getWeightUnit(req) : undefined,
      status: options.statusOverride,
      orderKey,
    });
  } catch (err) {
    const message = errorText(err);
    await recordSyncState(req, orderId, {
      sync_status: 'error',
      last_error: message,
      resync_requested: false,
    });
    return { orderId, ok: false, action: 'error', message, retryable: false };
  }

  // Digital-only orders have nothing to ship; keep them out of ShipStation entirely.
  if (payload.items.length === 0 && !state.order_key) {
    await recordSyncState(req, orderId, {
      sync_status: 'skipped',
      last_error: 'Order has no shippable items, so it was not sent to ShipStation.',
      resync_requested: false,
    });
    return {
      orderId,
      ok: true,
      action: 'skipped_no_items',
      message: 'Order has no shippable items.',
    };
  }

  // Nothing ShipStation would see has changed since the last push (for example, the
  // order.updated that recording a shipment fires, which rewrites the items' delivered
  // quantities). Return without a call and without a write, so nothing re-triggers.
  const hash = await payloadHash(payload);
  if (options.skipIfUnchanged && state.payload_hash === hash) {
    return {
      orderId,
      ok: true,
      action: 'skipped_unchanged',
      message: 'Nothing ShipStation shows for this order has changed.',
    };
  }

  if (options.guardShipped) {
    const status = await remoteStatus(client, state, orderKey);
    if (status && SHIPSTATION_FINAL_STATUSES.includes(status)) {
      const alreadyCancelled = status === 'cancelled' && options.statusOverride === 'cancelled';
      await recordSyncState(req, orderId, {
        sync_status: alreadyCancelled ? 'canceled' : 'skipped',
        last_error: alreadyCancelled
          ? null
          : `ShipStation has already marked this order "${status}" and no longer accepts changes to it.`,
        resync_requested: false,
        // Remembered so the same unchanged order is not probed again on the next update.
        payload_hash: hash,
      });
      return {
        orderId,
        ok: true,
        action: alreadyCancelled ? 'pushed' : 'skipped_already_shipped',
        message: `ShipStation order status is "${status}".`,
      };
    }
  }

  try {
    const result = await client.createOrder(payload);
    const shipstationOrderId = Number(result?.orderId);
    await recordSyncState(req, orderId, {
      sync_status: options.successStatus ?? 'synced',
      order_key: payload.orderKey,
      shipstation_order_id: Number.isFinite(shipstationOrderId)
        ? shipstationOrderId
        : (state.shipstation_order_id ?? null),
      shipstation_order_number: payload.orderNumber,
      last_synced_at: new Date().toISOString(),
      last_error: null,
      resync_requested: false,
      payload_hash: hash,
    });
    console.log(
      `ShipStation: pushed order ${payload.orderNumber} as "${payload.orderStatus}" (${payload.items.length} item(s))`,
    );
    return {
      orderId,
      ok: true,
      action: 'pushed',
      shipstationOrderId: Number.isFinite(shipstationOrderId) ? shipstationOrderId : undefined,
    };
  } catch (err) {
    const message = errorText(err);
    const retryable = err instanceof ShipStationError ? err.retryable : true;
    await recordSyncState(req, orderId, {
      sync_status: 'error',
      last_error: message,
      resync_requested: false,
    });
    console.error(`ShipStation: push failed for order ${payload.orderNumber}: ${message}`);
    return { orderId, ok: false, action: 'error', message, retryable };
  }
}

/**
 * A short digest of everything sent to ShipStation for an order. Two pushes with the same
 * digest would leave ShipStation exactly as it was.
 */
export async function payloadHash(payload: ShipStationOrder): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest.slice(0, 12)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Model-event handlers call this so a failed push shows up as a failed delivery.
 * Retryable failures are rethrown for redelivery; permanent ones are recorded once.
 */
export function throwIfFailed(result: PushResult): void {
  if (result.ok) {
    return;
  }
  throw new SwellError(result.message ?? `ShipStation push failed (${result.action})`, {
    status: 502,
    retry: result.retryable !== false,
  });
}
