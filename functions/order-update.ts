import { pushOrder, throwIfFailed } from './lib/push';
import { appId, getSettings } from './lib/settings';

// No conditions, deliberately. Two things were measured against the platform:
// a condition referencing `$settings` stops the event being dispatched at all, and
// `{'$data.shipping': {$exists: true}}` matches every update because `$data` resolves
// against the whole record rather than the changed fields. Both gates therefore live in the
// handler, which reads `$event.data` — the one place that really does hold only the change.
export const config: SwellConfig = {
  description: 'Re-push order edits and dashboard re-sync requests to ShipStation',
  model: {
    events: ['order.updated'],
  },
};

/** Edits the "Sync order edits" setting covers. */
const EDIT_FIELDS = ['shipping', 'billing', 'items'];

/**
 * Changes to what ShipStation shows as the order's status (awaiting payment, on hold,
 * awaiting shipment). Always sent, whatever "Sync order edits" says: an order paid after
 * it was sent would otherwise stay Awaiting Payment in ShipStation.
 */
const STATUS_FIELDS = ['paid', 'hold'];

export default async function (req: SwellRequest) {
  const settings = await getSettings(req);
  if (!settings.enabled) {
    return;
  }

  const changed = req.data.$event?.data ?? {};
  const resyncRequested = changed.$app?.[appId(req)]?.resync_requested === true;
  const statusChanged = STATUS_FIELDS.some((field) => field in changed);
  const edited = EDIT_FIELDS.some((field) => field in changed);

  // Sync state is only ever written under $app.<app_id>.*, and clearing the re-sync flag
  // sets it to false, so the app's own order writes stop here.
  if (!resyncRequested && !statusChanged && !(edited && settings.sync_updates)) {
    return;
  }

  throwIfFailed(
    await pushOrder(req, settings, req.data.id, {
      // A manual re-sync may legitimately be the first push, for instance when the trigger
      // is set to "manual". An incidental edit should not create an order ShipStation has
      // never seen.
      requireExisting: !resyncRequested,
      guardShipped: true,
      // Recording a shipment rewrites the order's items (their delivered quantities), so
      // every label this app records fires order.updated with `items` changed. Nothing
      // ShipStation sees has changed, and the push is skipped without a write. The same
      // goes for any other update that leaves the ShipStation order as it was.
      skipIfUnchanged: !resyncRequested,
    }),
  );
}
