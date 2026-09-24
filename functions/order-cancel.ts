import { pushOrder, throwIfFailed } from './lib/push';
import { getSettings } from './lib/settings';

// `$settings` is not usable here — a condition referencing app settings prevents the
// platform from dispatching the event at all. Settings are checked in the handler.
export const config: SwellConfig = {
  description: 'Mark orders cancelled in ShipStation when canceled in Swell',
  model: {
    events: ['order.canceled'],
  },
};

export default async function (req: SwellRequest) {
  const settings = await getSettings(req);
  if (!settings.enabled || !settings.sync_cancels) {
    return;
  }

  throwIfFailed(
    await pushOrder(req, settings, req.data.id, {
      requireExisting: true,
      guardShipped: true,
      statusOverride: 'cancelled',
      successStatus: 'canceled',
    }),
  );
}
