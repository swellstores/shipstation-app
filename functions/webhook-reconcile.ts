import { getSettings, hasCredentials } from './lib/settings';
import { reconcileWebhooks, removeWebhooks } from './lib/webhooks';

export const config: SwellConfig = {
  description: 'Ensure ShipStation shipment webhooks stay registered',
  cron: {
    schedule: '0 6 * * *',
  },
};

/**
 * There is no event for an app's own settings changing, so registration converges here
 * instead. This also repairs subscriptions that ShipStation drops or that point at a stale
 * callback URL after the webhook secret is rotated.
 */
export default async function (req: SwellRequest) {
  const settings = await getSettings(req);

  // Switched off: take the subscriptions down, as the native integration does when it is
  // deactivated, so ShipStation stops posting to a route that will ignore it.
  if (!settings.enabled && hasCredentials(settings)) {
    const removed = await removeWebhooks(req, settings);
    const count = removed.outcomes.filter((outcome) => outcome.action === 'removed').length;
    if (count > 0 || !removed.ok) {
      console.log(
        `ShipStation: app is switched off; removed ${count} webhook subscription(s)` +
          (removed.ok ? '.' : ', some could not be removed.'),
      );
    }
    return;
  }

  if (!settings.enabled || !hasCredentials(settings) || !settings.webhook_secret) {
    console.log(
      'ShipStation: skipping webhook reconciliation because the app is not fully configured.',
    );
    return;
  }

  const result = await reconcileWebhooks(req, settings);

  for (const outcome of result.outcomes) {
    const line = `ShipStation webhook ${outcome.event}: ${outcome.action}${
      outcome.message ? ` — ${outcome.message}` : ''
    }`;
    if (outcome.action === 'failed') {
      console.error(line);
    } else if (outcome.action !== 'kept') {
      console.log(line);
    }
  }

  if (!result.ok) {
    throw new SwellError('One or more ShipStation webhook subscriptions could not be repaired', {
      status: 502,
    });
  }
}
