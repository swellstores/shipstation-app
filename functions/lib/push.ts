import { mapOrder, shippableItems } from './order-mapper';
import { ShipStationSettings, hasCredentials } from './settings';
import {
  PROBE_TIMEOUT_MS,
  ShipStationClient,
  ShipStationError,
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
): Promise<string | null> {
  try {
    if (state.shipstation_order_id) {
      const order = await client.getOrder(state.shipstation_order_id, PROBE_TIMEOUT_MS);
      return order?.orderStatus ?? null;
    }
    if (state.shipstation_order_number) {
      const order = await client.findOrderByNumber(
        state.shipstation_order_number,
        PROBE_TIMEOUT_MS,
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

  if (options.guardShipped) {
    const status = await remoteStatus(client, state);
    if (status && SHIPSTATION_FINAL_STATUSES.includes(status)) {
      const alreadyCancelled = status === 'cancelled' && options.statusOverride === 'cancelled';
      await recordSyncState(req, orderId, {
        sync_status: alreadyCancelled ? 'canceled' : 'skipped',
        last_error: alreadyCancelled
          ? null
          : `ShipStation has already marked this order "${status}" and no longer accepts changes to it.`,
        resync_requested: false,
      });
      return {
        orderId,
        ok: true,
        action: alreadyCancelled ? 'pushed' : 'skipped_already_shipped',
        message: `ShipStation order status is "${status}".`,
      };
    }
  }

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
