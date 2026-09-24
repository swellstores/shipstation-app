import { pushOrder, PushResult } from './lib/push';
import { appId, getSettings, hasCredentials } from './lib/settings';

export const config: SwellConfig = {
  description: 'Push existing open orders to ShipStation after setup',
  cron: {
    schedule: '*/5 * * * *',
  },
};

/** Orders per run. Each push is one ShipStation call plus two Swell reads. */
export const BATCH_SIZE = 5;

/**
 * Stop starting new pushes past this point. A push is bounded at 4s by the client, and
 * functions get 10s, so the last push always has room to finish and record its outcome.
 */
export const TIME_BUDGET_MS = 5000;

/**
 * Sends the orders that were already open when the app was set up, the way the native
 * integration does on its first sync (swell-admin `lib/shipstation.js`, `syncOrders`):
 * paid, not canceled, not closed, with items still to ship.
 *
 * Without this, a merchant switching over starts with an empty ShipStation and every
 * order placed before the switch has to be pushed by hand.
 *
 * Stateless on purpose. "Not yet synced" is an order with no `sync_status` from this app,
 * and every push records one (synced, skipped or error), so each run picks up where the
 * last stopped, an order is never pushed twice, and the job goes quiet on its own once
 * nothing is left. Orders that failed are left to the `resync` route rather than retried
 * here forever.
 *
 * The `$app` filter is a collection scan (the platform has no custom indexes). The other
 * filters narrow it to open paid orders, which is a small set on most stores.
 */
export default async function (req: SwellRequest) {
  const settings = await getSettings(req);

  if (!settings.enabled || !settings.sync_existing || !hasCredentials(settings)) {
    return { ok: true, ignored: 'Existing-order sync is off or the app is not configured.' };
  }

  const started = Date.now();
  const response = (await req.swell.get('/orders', {
    where: {
      paid: true,
      canceled: { $ne: true },
      closed: { $ne: true },
      item_quantity_deliverable: { $gt: 0 },
      [`$app.${appId(req)}.sync_status`]: { $exists: false },
    },
    sort: 'date_created asc',
    limit: BATCH_SIZE,
    fields: 'id',
  } as any)) as { results?: Array<{ id: string }> } | null;

  const ids = (response?.results ?? []).map((order) => order.id);
  if (ids.length === 0) {
    return { ok: true, pushed: 0, message: 'No existing orders left to send.' };
  }

  const results: PushResult[] = [];
  for (const id of ids) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      break;
    }
    results.push(await pushOrder(req, settings, id));
  }

  const pushed = results.filter((result) => result.action === 'pushed').length;
  console.log(
    `ShipStation: existing-order sync sent ${pushed} of ${results.length} order(s) this run.`,
  );
  // Cron runs are not retried by the platform, so failures are recorded on each order
  // (sync_status "error") for the resync route, not thrown.
  return { ok: true, pushed, attempted: results.length, results };
}
