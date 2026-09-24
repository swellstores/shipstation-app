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
}

function namePrefix(req: SwellRequest): string {
  return `swell-${req.store.id}-`;
}

/**
 * Subscriptions this app created: named with this store's prefix, or pointing at this
 * store's webhook route under either the ObjectId or the old string-id URL (so the dead
 * string-id subscriptions left by earlier versions are found and replaced).
 */
function isOurs(req: SwellRequest, record: ShipStationWebhookRecord): boolean {
  const url = webhookUrl(record);
  return (
    webhookName(record).startsWith(namePrefix(req)) ||
    (url.includes(`://${req.store.id}.swell.store/functions/`) &&
      url.includes(`/${WEBHOOK_FUNCTION_NAME}`))
  );
}

function storeIdFor(settings: ShipStationSettings): number | undefined {
  if (!settings.store_id) {
    return undefined;
  }
  const parsed = Number(settings.store_id);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Brings ShipStation's webhook subscriptions in line with the app's settings. Safe to run
 * repeatedly: subscriptions that already point at the right URL are left alone.
 */
export async function reconcileWebhooks(
  req: SwellRequest,
  settings: ShipStationSettings,
): Promise<ReconcileResult> {
  const target = await webhookCallbackUrl(req, settings);
  const outcomes: WebhookOutcome[] = [];

  if (!target) {
    return {
      ok: false,
      target_url: '',
      outcomes: [{ event: '(all)', action: 'failed', message: CALLBACK_URL_UNAVAILABLE }],
    };
  }

  if (!hasCredentials(settings) || !settings.webhook_secret) {
    return {
      ok: false,
      target_url: target,
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
  const storeId = storeIdFor(settings);
  const ours = (await client.listWebhooks()).filter((record) => isOurs(req, record));

  for (const event of MANAGED_EVENTS) {
    const match = ours.find((record) => webhookEvent(record).toUpperCase() === event);
    const existingId = match ? webhookId(match) : null;

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
        friendly_name: `${namePrefix(req)}${event}`,
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

  // Clear out subscriptions this app owns but no longer uses, so a changed secret or
  // callback URL does not leave dead webhooks behind.
  for (const record of ours) {
    const event = webhookEvent(record).toUpperCase();
    if (MANAGED_EVENTS.includes(event as WebhookEvent)) {
      continue;
    }
    const id = webhookId(record);
    if (id === null) {
      continue;
    }
    try {
      await client.deleteWebhook(id);
      outcomes.push({ event: event || '(unknown)', action: 'removed', webhook_id: id });
    } catch (err) {
      outcomes.push({
        event: event || '(unknown)',
        action: 'failed',
        message: errorText(err),
      });
    }
  }

  return {
    ok: outcomes.every((outcome) => outcome.action !== 'failed'),
    target_url: target,
    outcomes,
  };
}

/**
 * Deletes every ShipStation webhook this app created, the counterpart of the native
 * integration's deactivate step. Run when the merchant switches the app off (the daily
 * reconcile cron) or on request from `setup` before uninstalling. The platform sends an
 * app no event on uninstall, so this cannot run by itself at that point.
 */
export async function removeWebhooks(
  req: SwellRequest,
  settings: ShipStationSettings,
): Promise<ReconcileResult> {
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
  const ours = (await client.listWebhooks()).filter((record) => isOurs(req, record));
  const outcomes: WebhookOutcome[] = [];

  for (const record of ours) {
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
