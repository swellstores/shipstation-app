/**
 * Which Swell environment (live, test, ...) this invocation runs in.
 *
 * A store's live and test environments each install the app with their own settings, and
 * a merchant can give both the same ShipStation account. Everything the app creates in
 * that account is therefore tagged with the environment, so the two never adopt, replace
 * or delete each other's webhooks, and a shipment for a test order is never attached to a
 * live one.
 *
 * The platform has no documented field for the environment. It does send it in the
 * `Swell-Request-Log` header the function wrapper exposes as `req.logParams`:
 * schema-api-server `server/request.js` `logParams()` puts `client_id` and
 * `environment_id` on every event, cron and route invocation
 * (`server/model/event-hooks.js`, `api/admin/features/events/functions.js`,
 * `api/admin/features/functions/index.js`). `environment_id` is `'test'` in the test
 * environment and empty in live.
 *
 * `known` is false when that header is missing, so callers can refuse anything that
 * could touch another environment's resources rather than guess.
 */
export interface SwellEnvironment {
  /** `null` for live. */
  id: string | null;
  known: boolean;
}

export const LIVE = 'live';

/** Environment ids end up in webhook names and order keys, so keep them to a safe set. */
const ENVIRONMENT_ID = /^[a-z0-9_]+$/i;

export function swellEnvironment(req: SwellRequest): SwellEnvironment {
  const params = (req.logParams ?? null) as Record<string, unknown> | null;
  if (!params || typeof params !== 'object' || !params.client_id) {
    return { id: null, known: false };
  }
  const raw = params.environment_id;
  const id = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
  if (id !== null && !ENVIRONMENT_ID.test(id)) {
    return { id: null, known: false };
  }
  return { id, known: true };
}

export function isLive(env: SwellEnvironment): boolean {
  return env.id === null;
}

/** `live`, or the environment id. */
export function environmentName(env: SwellEnvironment): string {
  return env.id ?? LIVE;
}

const SWELL_ID = /^[0-9a-f]{24}$/i;

/**
 * The `orderKey` sent to ShipStation. Live keeps the bare Swell order id, which is what
 * the built-in integration and every earlier version of this app sent, so existing live
 * orders keep upserting in place. Other environments prefix it (`test:<id>`), so their
 * orders are separate ShipStation orders and their shipments are recognisably theirs.
 */
export function orderKeyFor(env: SwellEnvironment, orderId: string): string {
  return env.id === null ? String(orderId) : `${env.id}:${orderId}`;
}

/**
 * Reverses `orderKeyFor`. `null` when the key was not made by a Swell environment (an
 * order from another sales channel, or one keyed by hand).
 */
export function parseOrderKey(
  key: string | null | undefined,
): { environment: string; orderId: string } | null {
  if (typeof key !== 'string') {
    return null;
  }
  const trimmed = key.trim();
  if (SWELL_ID.test(trimmed)) {
    return { environment: LIVE, orderId: trimmed };
  }
  const match = /^([a-z0-9_]+):([0-9a-f]{24})$/i.exec(trimmed);
  if (match && match[1].toLowerCase() !== LIVE) {
    return { environment: match[1], orderId: match[2] };
  }
  return null;
}
