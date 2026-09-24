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

export default async function (req: SwellRequest) {
  const settings = await getSettings(req);
  if (!settings.enabled) {
    return;
  }

  const changed = req.data.$event?.data ?? {};
  const resyncRequested = changed.$app?.[appId(req)]?.resync_requested === true;
  const addressChanged = 'shipping' in changed;
  const itemsChanged = 'items' in changed;

  // This guard is what keeps the app from reacting to its own writes. Sync state is only
  // ever written under $app.<app_id>.*, never to shipping or items, and clearing the
  // re-sync flag sets it to false — so none of those writes get past here.
  if (!resyncRequested && !addressChanged && !itemsChanged) {
    return;
  }
  if (!resyncRequested && !settings.sync_updates) {
    return;
  }

  throwIfFailed(
    await pushOrder(req, settings, req.data.id, {
      // A manual re-sync may legitimately be the first push, for instance when the trigger
      // is set to "manual". An incidental edit should not create an order ShipStation has
      // never seen.
      requireExisting: !resyncRequested,
      guardShipped: true,
    }),
  );
}
