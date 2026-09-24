import { ingestShipments } from './lib/shipment-ingester';
import { getSettings, hasCredentials, ShipStationSettings } from './lib/settings';
import { ShipStationClient, ShipStationShipment } from './lib/shipstation';

export const config: SwellConfig = {
  description: 'Receive ShipStation shipment notifications and create Swell shipments',
  route: {
    methods: ['post'],
    public: true,
  },
};

/**
 * AUTHENTICATION
 *
 * A ShipStation notification carries no shipment data, only a `resource_url`, and this
 * route fetches that URL itself, from a ShipStation API host, with the merchant's API
 * credentials (`ShipStationClient.fetchShipments`). What gets ingested is therefore always
 * the merchant's real shipments, whoever sent the notification. The worst a forged call
 * can do is make the app re-read shipments it already dedupes.
 *
 * That matters because the `?secret=` in the callback URL never arrives: Swell's
 * public-route proxy passes a function the body *or* the query string, never both, and
 * ShipStation always sends a body. Measured live 2026-09-24, Asana 1218816382065204.
 *
 * So the secret is optional. A secret that arrives and is wrong is still refused. The one
 * path that trusts the body, inline `shipments` under `allow_test_payload`, requires a
 * matching secret, because nothing else vouches for those records.
 */

/** Shipment notifications. Everything else is acknowledged and ignored. */
const HANDLED_EVENTS = ['SHIP_NOTIFY', 'ITEM_SHIP_NOTIFY'];

const MAX_PAGES = 3;

/**
 * Compares the secret without leaking how much of it matched. The length check is fine to
 * short-circuit: the secret's length is not the part worth protecting.
 */
function secretsMatch(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < provided.length; i += 1) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

async function collectShipments(
  settings: ShipStationSettings,
  body: Record<string, any>,
  secretVerified: boolean,
): Promise<ShipStationShipment[]> {
  if (settings.allow_test_payload && Array.isArray(body.shipments)) {
    if (!secretVerified) {
      // Inline shipments are taken on trust, so this path alone needs the secret.
      throw new SwellError('Test payloads require the webhook secret', { status: 401 });
    }
    console.log(
      `ShipStation: reading ${body.shipments.length} shipment(s) from the request body (test payloads are enabled)`,
    );
    return body.shipments as ShipStationShipment[];
  }

  const resourceUrl = typeof body.resource_url === 'string' ? body.resource_url : '';
  if (!resourceUrl) {
    throw new SwellError('Webhook body has no resource_url', { status: 400 });
  }
  if (!hasCredentials(settings)) {
    throw new SwellError('ShipStation API credentials are not set in app settings', {
      status: 503,
    });
  }

  const client = new ShipStationClient(settings.api_key, settings.api_secret);
  const collected: ShipStationShipment[] = [];
  let next: string = resourceUrl;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await client.fetchShipments(next);
    collected.push(...(response?.shipments ?? []));

    const pages = Number(response?.pages ?? 1);
    if (!Number.isFinite(pages) || page >= pages) {
      if (Number.isFinite(pages) && pages > MAX_PAGES) {
        console.warn(
          `ShipStation: resource has ${pages} pages but only ${MAX_PAGES} were read; the rest arrive with the next notification.`,
        );
      }
      break;
    }
    const url = new URL(resourceUrl);
    url.searchParams.set('page', String(page + 1));
    next = url.toString();
  }

  return collected;
}

export async function post(req: SwellRequest) {
  const settings = await getSettings(req);

  const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<
    string,
    any
  >;

  // A real ShipStation delivery never carries the secret (see AUTHENTICATION above), but
  // an admin-API test does: `swell api post` folds the query into the body. A secret that
  // is present and wrong is somebody guessing, so that is still refused.
  const provided =
    req.query.secret ?? (typeof body.secret === 'string' ? body.secret : undefined) ?? '';
  const secretVerified = Boolean(
    provided && settings.webhook_secret && secretsMatch(provided, settings.webhook_secret),
  );
  if (provided && !secretVerified) {
    console.warn('ShipStation: rejected a webhook delivery with an invalid secret');
    throw new SwellError('Invalid webhook secret', { status: 401 });
  }

  if (!settings.enabled || !settings.create_shipments) {
    return { ok: true, ignored: 'Shipment sync is turned off in app settings.' };
  }

  const resourceType = String(body.resource_type ?? '').toUpperCase();

  if (resourceType && !HANDLED_EVENTS.includes(resourceType)) {
    // Acknowledge so ShipStation does not disable the subscription over an event we do not
    // act on.
    return { ok: true, ignored: `Unhandled resource_type "${resourceType}".` };
  }

  const shipments = await collectShipments(settings, body, secretVerified);
  if (shipments.length === 0) {
    return { ok: true, received: 0, message: 'Notification contained no shipments.' };
  }

  const summary = await ingestShipments(req, settings, shipments);
  const payload = {
    resource_type: resourceType || null,
    received: shipments.length,
    created: summary.created,
    canceled: summary.canceled,
    duplicates: summary.duplicates,
    skipped: summary.skipped,
    failed: summary.failed,
    details: summary.details,
  };

  // Nothing landed and something broke: answer with a retryable status so ShipStation
  // redelivers. Partial success is reported as 200 — the failures are recorded on the
  // orders and retrying would duplicate the shipments that did succeed.
  if (summary.failed > 0 && summary.created === 0 && summary.canceled === 0) {
    return new SwellResponse({ ok: false, ...payload }, { status: 503 });
  }

  return { ok: true, ...payload };
}
