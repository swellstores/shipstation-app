import { BACKFILL_INTERVAL_MS, backfillOff, backfillsPath, unsentOrdersWhere } from './lib/backfill';
import { pushOrder, PushResult } from './lib/push';
import { getSettings } from './lib/settings';

export const config: SwellConfig = {
  description: 'Push existing open orders to ShipStation after setup, a batch at a time',
  model: {
    events: ['backfill.created', 'backfill.updated'],
    conditions: { status: 'pending' },
    // Runs at date_next_run: right away for a new run, then once per batch. A finished
    // run clears it. Test connection and the daily webhook-reconcile start runs.
    schedule: { formula: 'date_next_run' },
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
 * paid, not canceled, not closed, with items still to ship. It follows the push trigger:
 * with "Only when re-synced manually" it sends nothing.
 *
 * Without this, a merchant switching over starts with an empty ShipStation and every
 * order placed before the switch has to be pushed by hand.
 *
 * Each batch belongs to a backfill run (`backfills`), which Test connection starts, and the
 * daily webhook-reconcile starts whenever paid open orders are still unsent. "Not yet synced" is
 * an order with no `sync_status` from this app, and every push records one (synced,
 * skipped or error), so each batch picks up where the last stopped, an order is never
 * pushed twice, and the run finishes once nothing is left. Orders that failed are left to
 * the `resync` route rather than retried here forever.
 *
 * The `$app` filter is a collection scan (the platform has no custom indexes). The other
 * filters narrow it to open paid orders, which is a small set on most stores.
 */
export default async function (req: SwellRequest) {
  const path = backfillsPath(req);
  const job = (req.data?.id ? await req.swell.get(`${path}/${req.data.id}`) : null) as {
    id: string;
    status?: string;
    pushed_count?: number;
    attempted_count?: number;
  } | null;

  // Finished in the meantime
  if (!job || job.status !== 'pending') {
    return { ok: true, ignored: 'This existing-order sync is no longer running.' };
  }

  const finish = (result: string) =>
    req.swell.put(`${path}/${job.id}`, {
      status: 'done',
      date_completed: new Date().toISOString(),
      date_next_run: null,
      result,
    });

  const settings = await getSettings(req);
  const off = backfillOff(settings);
  if (off) {
    await finish(off);
    return { ok: true, ignored: off };
  }

  const started = Date.now();
  const response = (await req.swell.get('/orders', {
    where: unsentOrdersWhere(req),
    sort: 'date_created asc',
    limit: BATCH_SIZE,
    fields: 'id',
  } as any)) as { results?: Array<{ id: string }> } | null;

  const ids = (response?.results ?? []).map((order) => order.id);
  if (ids.length === 0) {
    await finish('No existing orders left to send.');
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
    `ShipStation: existing-order sync sent ${pushed} of ${results.length} order(s) this batch.`,
  );
  await req.swell.put(`${path}/${job.id}`, {
    pushed_count: (job.pushed_count ?? 0) + pushed,
    attempted_count: (job.attempted_count ?? 0) + results.length,
    date_next_run: new Date(Date.now() + BACKFILL_INTERVAL_MS).toISOString(),
  });
  // Failures are recorded on each order (sync_status "error") for the resync route, not
  // thrown, so one bad order doesn't stop the run.
  return { ok: true, pushed, attempted: results.length, results };
}
