import { pushOrder, throwIfFailed } from './lib/push';
import { getSettings } from './lib/settings';

// Conditions deliberately omit `$settings`: a condition referencing app settings stops the
// platform dispatching the event at all (the event records zero pending deliveries), so
// every gate below is enforced in the handler instead.
export const config: SwellConfig = {
  description: 'Push orders to ShipStation when the configured trigger fires',
  model: {
    events: ['order.submitted', 'order.paid'],
  },
};

export default async function (req: SwellRequest) {
  const settings = await getSettings(req);
  if (!settings.enabled) {
    return;
  }

  // Both events are subscribed so the merchant can change the trigger without a redeploy;
  // the handler decides which one actually pushes.
  if (settings.push_trigger === 'manual') {
    return;
  }
  if (req.data.$event?.type !== `order.${settings.push_trigger}`) {
    return;
  }

  throwIfFailed(await pushOrder(req, settings, req.data.id));
}
