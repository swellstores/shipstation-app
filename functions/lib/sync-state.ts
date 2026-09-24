import { appId } from './settings';
import { errorText } from './shipstation';

export type SyncStatus = 'pending' | 'synced' | 'error' | 'skipped' | 'canceled';

export interface SyncState {
  sync_status?: SyncStatus | null;
  order_key?: string | null;
  shipstation_order_id?: number | null;
  shipstation_order_number?: string | null;
  last_synced_at?: string | null;
  last_error?: string | null;
  last_webhook_at?: string | null;
  shipments_count?: number | null;
  resync_requested?: boolean | null;
}

const MAX_ERROR_LENGTH = 500;

export function readSyncState(req: SwellRequest, record: unknown): SyncState {
  const app = (record as Record<string, any>)?.$app;
  return (app?.[appId(req)] ?? {}) as SyncState;
}

/**
 * The single place this app writes to an order. Every write is confined to
 * `$app.<app_id>.*`, which is what stops order-update from reacting to our own writes.
 */
export async function setSyncState(
  req: SwellRequest,
  orderId: string,
  patch: SyncState,
): Promise<void> {
  const values: SyncState = { ...patch };
  if (typeof values.last_error === 'string') {
    values.last_error = values.last_error.slice(0, MAX_ERROR_LENGTH);
  }
  await req.swell.put(`/orders/${orderId}`, req.appValues(values));
}

/**
 * Records sync state without letting a failed write mask the error that prompted it.
 */
export async function recordSyncState(
  req: SwellRequest,
  orderId: string,
  patch: SyncState,
): Promise<void> {
  try {
    await setSyncState(req, orderId, patch);
  } catch (err) {
    console.error(
      `ShipStation: could not record sync state on order ${orderId}: ${errorText(err)}`,
    );
  }
}
