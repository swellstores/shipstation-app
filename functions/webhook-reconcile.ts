import { rearmBackfills, startBackfill } from './lib/backfill';
import { environmentName, swellEnvironment } from './lib/environment';
import { errorText } from './lib/shipstation';
import { getSettings, hasCredentials } from './lib/settings';
import { ENVIRONMENT_UNKNOWN } from './lib/webhooks';
import { reconcileWebhooks, removeWebhooks } from './lib/webhooks';

export const config: SwellConfig = {
  description: 'Ensure ShipStation shipment webhooks stay registered',
  cron: {
    schedule: '0 6 * * *',
    // Not while the app has no credentials: there is nothing to register or remove
    conditions: { $settings: { shipstation: { api_key: { $empty: false } } } },
  },
};

/**
 * There is no event for an app's own settings changing, so registration converges here
 * instead. This also repairs subscriptions that ShipStation drops or that point at a stale
 * callback URL after the webhook secret is rotated.
 */
export default async function (req: SwellRequest) {
  // Live and test can share a ShipStation account. Only ever touch this environment's
  // own subscriptions, and touch none when the environment cannot be told.
  const env = swellEnvironment(req);
  if (!env.known) {
    console.warn(`ShipStation: ${ENVIRONMENT_UNKNOWN}`);
    return;
  }

  const settings = await getSettings(req);

  // Existing open orders: once a day, start a run when paid open orders are still unsent
  // (the first after setup for merchants who never ran Test connection, or ones paid while
  // the app was off), and pick up a run whose scheduled batch was lost.
  try {
    await rearmBackfills(req);
    if (await startBackfill(req, settings, { onlyIfUnsent: true })) {
      console.log('ShipStation: started sending open orders that are not in ShipStation yet.');
    }
  } catch (err) {
    console.error(`ShipStation: couldn't check the existing-order sync: ${errorText(err)}`);
  }

  // Switched off: take the subscriptions down, as the native integration does when it is
  // deactivated, so ShipStation stops posting to a route that will ignore it.
  if (!settings.enabled && hasCredentials(settings)) {
    const removed = await removeWebhooks(req, settings);
    const count = removed.outcomes.filter((outcome) => outcome.action === 'removed').length;
    if (count > 0 || !removed.ok) {
      console.log(
        `ShipStation: app is switched off in ${environmentName(env)}; removed ${count} webhook subscription(s)` +
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
  if (result.message) {
    console.log(`ShipStation: ${result.message}`);
  }

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
