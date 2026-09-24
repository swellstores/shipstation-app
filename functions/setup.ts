import {
  CALLBACK_URL_UNAVAILABLE,
  getSettings,
  hasCredentials,
  webhookCallbackUrl,
} from './lib/settings';
import { ShipStationClient, errorText } from './lib/shipstation';
import { describeWebhooks, reconcileWebhooks, removeWebhooks } from './lib/webhooks';

export const config: SwellConfig = {
  description: 'Validate ShipStation credentials and register shipment webhooks',
  route: {
    methods: ['get', 'post'],
    public: false,
  },
};

function maskSecret(url: string): string {
  return url.replace(/secret=[^&]*/, 'secret=***');
}

async function report(req: SwellRequest, register: boolean) {
  const settings = await getSettings(req);

  const callbackUrl = await webhookCallbackUrl(req, settings);

  const result: Record<string, unknown> = {
    enabled: settings.enabled,
    push_trigger: settings.push_trigger,
    credentials_set: hasCredentials(settings),
    webhook_secret_set: Boolean(settings.webhook_secret),
    callback_url: callbackUrl ? maskSecret(callbackUrl) : null,
    callback_url_source: settings.callback_url
      ? 'settings override'
      : callbackUrl
        ? "derived from this app's ObjectId"
        : CALLBACK_URL_UNAVAILABLE,
    callback_url_note:
      'Public route functions resolve the live environment. Install the app to live before ' +
      'registering webhooks, or set a callback URL override while developing.',
  };

  if (!hasCredentials(settings)) {
    return {
      ...result,
      credentials_ok: false,
      message: 'Add the ShipStation API key and secret in app settings, then run this again.',
    };
  }

  const client = new ShipStationClient(settings.api_key, settings.api_secret);

  try {
    const stores = await client.listStores();
    result.credentials_ok = true;
    result.shipstation_stores = stores.map((store) => ({
      storeId: store.storeId,
      storeName: store.storeName,
      active: store.active,
    }));
  } catch (err) {
    return { ...result, credentials_ok: false, message: errorText(err) };
  }

  if (!settings.webhook_secret) {
    return {
      ...result,
      message: 'Set a webhook secret in app settings, then POST here to register webhooks.',
    };
  }

  if (!register) {
    try {
      result.webhooks = describeWebhooks(await client.listWebhooks());
    } catch (err) {
      result.webhooks_error = errorText(err);
    }
    return {
      ...result,
      message: 'POST to this endpoint to register or repair the ShipStation webhooks.',
    };
  }

  const reconciled = await reconcileWebhooks(req, settings);
  return {
    ...result,
    webhooks_ok: reconciled.ok,
    webhooks: reconciled.outcomes,
    message: reconciled.ok
      ? 'ShipStation webhooks are registered. Remember to disable the native ShipStation integration so orders are not pushed twice.'
      : 'Some webhook subscriptions could not be registered — see webhooks for details.',
  };
}

/** Reports configuration and current subscriptions without changing anything. */
export function get(req: SwellRequest) {
  return report(req, false);
}

/**
 * Registers or repairs the shipment webhooks. Safe to call repeatedly.
 *
 * `{ "action": "remove_webhooks" }` deletes them instead. Run it before uninstalling: the
 * platform sends an app no uninstall event, so the subscriptions would otherwise keep
 * posting to a route that no longer exists.
 */
export async function post(req: SwellRequest) {
  const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<
    string,
    any
  >;
  if (body.action === 'remove_webhooks') {
    const settings = await getSettings(req);
    const removed = await removeWebhooks(req, settings);
    return {
      ok: removed.ok,
      webhooks: removed.outcomes,
      message: removed.ok
        ? 'ShipStation webhook subscriptions removed. The app can be uninstalled now.'
        : 'Some webhook subscriptions could not be removed; see webhooks for details.',
    };
  }
  return report(req, true);
}
