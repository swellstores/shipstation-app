// Settings are namespaced by the settings filename, so everything lives under
// `shipstation` regardless of the app id.
const SETTINGS_KEY = 'shipstation';

/** `req.appId` is declared optional in @swell/app-types but is always set at runtime. */
export function appId(req: SwellRequest): string {
  return req.appId || SETTINGS_KEY;
}

export type PushTrigger = 'paid' | 'submitted' | 'manual';

export interface ShipStationSettings {
  enabled: boolean;
  api_key: string;
  api_secret: string;
  store_id: string;
  push_trigger: PushTrigger;
  order_prefix: string;
  sync_updates: boolean;
  sync_cancels: boolean;
  sync_existing: boolean;
  webhook_secret: string;
  callback_url: string;
  create_shipments: boolean;
  allow_test_payload: boolean;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function trigger(value: unknown): PushTrigger {
  return value === 'submitted' || value === 'manual' ? value : 'paid';
}

export async function getSettings(req: SwellRequest): Promise<ShipStationSettings> {
  const all = await req.swell.settings();
  const raw = (all?.[SETTINGS_KEY] ?? {}) as Record<string, unknown>;

  return {
    enabled: flag(raw.enabled, false),
    api_key: text(raw.api_key),
    api_secret: text(raw.api_secret),
    store_id: text(raw.store_id),
    push_trigger: trigger(raw.push_trigger),
    // Deliberately not trimmed: a trailing space in a prefix is still a prefix.
    order_prefix: typeof raw.order_prefix === 'string' ? raw.order_prefix : '',
    sync_updates: flag(raw.sync_updates, true),
    sync_cancels: flag(raw.sync_cancels, true),
    sync_existing: flag(raw.sync_existing, true),
    webhook_secret: text(raw.webhook_secret),
    callback_url: text(raw.callback_url),
    create_shipments: flag(raw.create_shipments, true),
    allow_test_payload: flag(raw.allow_test_payload, false),
  };
}

export function hasCredentials(settings: ShipStationSettings): boolean {
  return Boolean(settings.api_key && settings.api_secret);
}

/** This app's public route function — what ShipStation calls. */
export const WEBHOOK_FUNCTION_NAME = 'shipstation-webhook';

/**
 * Must match `shipstation-webhook.ts`'s `config.description` **verbatim**. `/:functions`
 * cannot be filtered by app, so `appObjectId()` matches on name and description together.
 * Change one and you must change the other.
 */
export const WEBHOOK_FUNCTION_DESCRIPTION =
  'Receive ShipStation shipment notifications and create Swell shipments';

/**
 * This app's ObjectId, the 24-character hex id in `.swellrc`, read from the platform's
 * function registry.
 *
 * A public route resolves at `<store_id>.swell.store/functions/<APP OBJECT ID>/<name>`. The
 * string-id form (`/functions/shipstation/…`) resolves only when the caller sends a Swell
 * API key (swell-admin `server/api/functions/index.js:16-18`), which ShipStation never
 * does, so it 404s. ShipStation accepts that URL, reports the subscription as created, and
 * every delivery is dropped. `req.appId` is the string id, so the ObjectId has to be looked
 * up. Same fix as `mailchimp-integration/functions/lib/settings.ts`.
 *
 * Exactly one match, or `null`: a URL that points at another app's function is worse than
 * no URL. Only setup and reconcile call this, never the delivery path.
 */
export async function appObjectId(req: SwellRequest): Promise<string | null> {
  try {
    const response = (await req.swell.get('/:functions', {
      where: { name: WEBHOOK_FUNCTION_NAME },
      limit: 20,
    } as any)) as { results?: Array<Record<string, any>> } | null;

    const matches = (response?.results ?? []).filter(
      (fn) =>
        fn?.name === WEBHOOK_FUNCTION_NAME &&
        fn?.description === WEBHOOK_FUNCTION_DESCRIPTION &&
        /^[0-9a-f]{24}$/i.test(String(fn?.app_id ?? '')),
    );
    return matches.length === 1 ? String(matches[0].app_id) : null;
  } catch (err) {
    console.warn(
      `ShipStation: could not read /:functions to derive this app's ObjectId: ${String(err)}`,
    );
    return null;
  }
}

/**
 * Public URL ShipStation posts shipment notifications to, or `null` when it cannot be
 * built. The `callback_url` setting overrides it (a tunnel during development).
 *
 * `null` rather than a fallback to the string-id form, on purpose: that form 404s silently,
 * so a fallback would turn a loud setup failure into dropped deliveries that look fine.
 *
 * The secret is appended so it takes effect if the platform ever forwards it; today it is
 * dropped on the way in, and the webhook authenticates by re-fetching (see
 * `shipstation-webhook.ts`). Public routes serve the **live** environment only.
 */
export async function webhookCallbackUrl(
  req: SwellRequest,
  settings: ShipStationSettings,
): Promise<string | null> {
  let base = settings.callback_url;
  if (!base) {
    const objectId = await appObjectId(req);
    if (!objectId) {
      return null;
    }
    base = `https://${req.store.id}.swell.store/functions/${objectId}/${WEBHOOK_FUNCTION_NAME}`;
  }
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}secret=${encodeURIComponent(settings.webhook_secret)}`;
}

/** Shown whenever the callback URL cannot be built. */
export const CALLBACK_URL_UNAVAILABLE =
  "Could not determine this app's public callback URL, so no webhooks were registered. " +
  'Push and install the app, then run setup again, or set the Callback URL override to ' +
  'https://<store_id>.swell.store/functions/<app ObjectId from .swellrc>/shipstation-webhook.';
