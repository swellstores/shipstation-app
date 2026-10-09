import {
  CALLBACK_URL_UNAVAILABLE,
  ShipStationSettings,
  WEBHOOK_FUNCTION_NAME,
  hasCredentials,
  webhookCallbackUrl,
} from './settings';
import {
  ShipStationClient,
  ShipStationWebhookRecord,
  WebhookEvent,
  errorText,
  webhookEvent,
  webhookId,
  webhookName,
  webhookUrl,
} from './shipstation';
import {
  LIVE,
  SwellEnvironment,
  environmentName,
  isLive,
  swellEnvironment,
} from './environment';

/**
 * ShipStation fires SHIP_NOTIFY when a whole order ships and ITEM_SHIP_NOTIFY when part of
 * one does, so both are needed for partial shipments to reach Swell.
 */
export const MANAGED_EVENTS: WebhookEvent[] = ['SHIP_NOTIFY', 'ITEM_SHIP_NOTIFY'];

export interface WebhookOutcome {
  event: string;
  action: 'created' | 'kept' | 'replaced' | 'removed' | 'failed';
  webhook_id?: number;
  message?: string;
}

export interface ReconcileResult {
  ok: boolean;
  target_url: string;
  outcomes: WebhookOutcome[];
  /** Set when nothing was registered on purpose, to say why. */
  message?: string;
}

/** Every event ShipStation can subscribe to, used to read a webhook name back. */
const ALL_EVENTS: WebhookEvent[] = [
  'ORDER_NOTIFY',
  'ITEM_ORDER_NOTIFY',
  'SHIP_NOTIFY',
  'ITEM_SHIP_NOTIFY',
  'FULFILLMENT_SHIPPED',
  'FULFILLMENT_REJECTED',
];

export const ENVIRONMENT_UNKNOWN =
  "Could not tell which Swell environment this is, so ShipStation's webhooks were left " +
  'untouched rather than risk changing the ones another environment owns.';

export const TEST_ENVIRONMENT_NOT_REACHABLE =
  "ShipStation can only reach a store's live environment, so this environment registers " +
  'no webhooks of its own. Set a Callback URL override (a tunnel, for example) to receive ' +
  'shipment notifications here.';

/**
 * Webhook names carry the store and, outside live, the environment:
 * `swell-<store>-<EVENT>` in live (unchanged from earlier versions, so live keeps
 * recognising the subscriptions it already has) and `swell-<store>.<env>-<EVENT>`
 * elsewhere. The `.` cannot appear in a store id, so a test environment's names can never
 * be read as another store's live ones (store `acme` in test vs store `acme-test` live).
 */
function webhookNameFor(req: SwellRequest, env: SwellEnvironment, event: WebhookEvent): string {
  return env.id === null
    ? `swell-${req.store.id}-${event}`
    : `swell-${req.store.id}.${env.id}-${event}`;
}

/**
 * The environment a webhook name was made for, or `null` when it was not made for this
 * store by this app.
 */
function nameEnvironment(req: SwellRequest, name: string): string | null {
  const envBase = `swell-${req.store.id}.`;
  if (name.startsWith(envBase)) {
    const match = /^([a-z0-9_]+)-([A-Z_]+)$/i.exec(name.slice(envBase.length));
    return match && ALL_EVENTS.includes(match[2].toUpperCase() as WebhookEvent)
      ? match[1]
      : null;
  }
  const liveBase = `swell-${req.store.id}-`;
  if (name.startsWith(liveBase)) {
    const rest = name.slice(liveBase.length).toUpperCase();
    return ALL_EVENTS.includes(rest as WebhookEvent) ? LIVE : null;
  }
  return null;
}

/** This store's live webhook route, under the ObjectId or the old string-id URL. */
function isLiveRouteUrl(req: SwellRequest, url: string): boolean {
  return (
    url.includes(`://${req.store.id}.swell.store/functions/`) &&
    url.includes(`/${WEBHOOK_FUNCTION_NAME}`)
  );
}

/**
 * Subscriptions this environment owns. A name made for this store decides it: live owns
 * the live-style names, each other environment only its own. A subscription renamed by
 * hand is recognised by its address, and only by live, because the store's public route
 * address only ever reaches the live environment. That is also how live finds the dead
 * string-id subscriptions earlier versions left, and any a pre-1.0.2 test environment
 * registered under a live-style name: they all pointed at the live route, so live adopts
 * and repairs them rather than leaving duplicates.
 */
function isOurs(
  req: SwellRequest,
  env: SwellEnvironment,
  record: ShipStationWebhookRecord,
): boolean {
  const owner = nameEnvironment(req, webhookName(record));
  if (owner !== null) {
    return owner.toLowerCase() === environmentName(env).toLowerCase();
  }
  return isLive(env) && isLiveRouteUrl(req, webhookUrl(record));
}

function storeIdFor(settings: ShipStationSettings): number | undefined {
  if (!settings.store_id) {
    return undefined;
  }
  const parsed = Number(settings.store_id);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Deletes the given subscriptions, reporting each one. */
async function deleteAll(
  client: ShipStationClient,
  records: ShipStationWebhookRecord[],
): Promise<WebhookOutcome[]> {
  const outcomes: WebhookOutcome[] = [];
  for (const record of records) {
    const event = webhookEvent(record).toUpperCase() || '(unknown)';
    const id = webhookId(record);
    if (id === null) {
      continue;
    }
    try {
      await client.deleteWebhook(id);
      outcomes.push({ event, action: 'removed', webhook_id: id });
    } catch (err) {
      outcomes.push({ event, action: 'failed', message: errorText(err) });
    }
  }
  return outcomes;
}

function unknownEnvironment(): ReconcileResult {
  return {
    ok: false,
    target_url: '',
    outcomes: [{ event: '(all)', action: 'failed', message: ENVIRONMENT_UNKNOWN }],
  };
}

/**
 * Brings this environment's ShipStation webhook subscriptions in line with the app's
 * settings. Safe to run repeatedly: subscriptions that already point at the right URL are
 * left alone, and subscriptions another environment owns are never touched.
 */
export async function reconcileWebhooks(
  req: SwellRequest,
  settings: ShipStationSettings,
): Promise<ReconcileResult> {
  const env = swellEnvironment(req);
  if (!env.known) {
    return unknownEnvironment();
  }

  if (!hasCredentials(settings) || !settings.webhook_secret) {
    return {
      ok: false,
      target_url: '',
      outcomes: [
        {
          event: '(all)',
          action: 'failed',
          message: 'ShipStation credentials and a webhook secret must be set first.',
        },
      ],
    };
  }

  const client = new ShipStationClient(settings.api_key, settings.api_secret);

  // Outside live, the derived address is the live route, so a subscription made here
  // would only deliver this environment's notifications to live. Without an override
  // the right state is no subscriptions at all, so any left from an old override go.
  if (!isLive(env) && !settings.callback_url) {
    const ours = (await client.listWebhooks()).filter((record) => isOurs(req, env, record));
    const outcomes = await deleteAll(client, ours);
    return {
      ok: outcomes.every((outcome) => outcome.action !== 'failed'),
      target_url: '',
      outcomes,
      message: TEST_ENVIRONMENT_NOT_REACHABLE,
    };
  }

  const target = await webhookCallbackUrl(req, settings);
  if (!target) {
    return {
      ok: false,
      target_url: '',
      outcomes: [{ event: '(all)', action: 'failed', message: CALLBACK_URL_UNAVAILABLE }],
    };
  }

  const outcomes: WebhookOutcome[] = [];
  const storeId = storeIdFor(settings);
  const ours = (await client.listWebhooks()).filter((record) => isOurs(req, env, record));
  const used = new Set<ShipStationWebhookRecord>();

  for (const event of MANAGED_EVENTS) {
    const candidates = ours.filter((record) => webhookEvent(record).toUpperCase() === event);
    // Prefer one that is already right, so a duplicate is what gets cleaned up below.
    const match = candidates.find((record) => webhookUrl(record) === target) ?? candidates[0];
    const existingId = match ? webhookId(match) : null;
    if (match) {
      used.add(match);
    }

    try {
      if (match && webhookUrl(match) === target) {
        outcomes.push({ event, action: 'kept', webhook_id: existingId ?? undefined });
        continue;
      }
      if (existingId !== null) {
        await client.deleteWebhook(existingId);
      }
      const created = await client.subscribeWebhook({
        target_url: target,
        event,
        friendly_name: webhookNameFor(req, env, event),
        ...(storeId === undefined ? {} : { store_id: storeId }),
      });
      outcomes.push({
        event,
        action: match ? 'replaced' : 'created',
        webhook_id: created?.id,
      });
    } catch (err) {
      outcomes.push({ event, action: 'failed', message: errorText(err) });
    }
  }

  // Clear out subscriptions this environment owns but no longer uses (other events, or
  // duplicates of a managed one), so a changed secret or callback URL leaves nothing
  // behind.
  outcomes.push(...(await deleteAll(client, ours.filter((record) => !used.has(record)))));

  return {
    ok: outcomes.every((outcome) => outcome.action !== 'failed'),
    target_url: target,
    outcomes,
  };
}

/**
 * Deletes every ShipStation webhook this environment created, the counterpart of the
 * native integration's deactivate step. Run when the merchant switches the app off (the
 * daily reconcile cron) or on request from `setup` before uninstalling. The platform
 * sends an app no event on uninstall, so this cannot run by itself at that point.
 * Subscriptions another environment owns are left alone.
 */
export async function removeWebhooks(
  req: SwellRequest,
  settings: ShipStationSettings,
): Promise<ReconcileResult> {
  const env = swellEnvironment(req);
  if (!env.known) {
    return unknownEnvironment();
  }
  if (!hasCredentials(settings)) {
    return {
      ok: false,
      target_url: '',
      outcomes: [
        { event: '(all)', action: 'failed', message: 'ShipStation credentials are not set.' },
      ],
    };
  }

  const client = new ShipStationClient(settings.api_key, settings.api_secret);
  const ours = (await client.listWebhooks()).filter((record) => isOurs(req, env, record));
  const outcomes = await deleteAll(client, ours);

  return {
    ok: outcomes.every((outcome) => outcome.action !== 'failed'),
    target_url: '',
    outcomes,
  };
}

export function describeWebhooks(
  records: ShipStationWebhookRecord[],
): Array<{ id: number | null; event: string; name: string; url: string }> {
  return records.map((record) => ({
    id: webhookId(record),
    event: webhookEvent(record),
    name: webhookName(record),
    url: webhookUrl(record).replace(/secret=[^&]*/, 'secret=***'),
  }));
}
