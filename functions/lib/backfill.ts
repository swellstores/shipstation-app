import { appId, hasCredentials, ShipStationSettings } from './settings';

/** Wait between batches of one existing-order sync. */
export const BACKFILL_INTERVAL_MS = 60 * 1000;

/** A pending run whose next batch is this late lost its scheduled run. */
const OVERDUE_GRACE_MS = 15 * 60 * 1000;

export function backfillsPath(req: SwellRequest): string {
  return `/apps/${appId(req)}/backfills`;
}

/** Why existing orders are not sent automatically, or null when they are. */
export function backfillOff(settings: ShipStationSettings): string | null {
  if (!settings.enabled || !settings.sync_existing || !hasCredentials(settings)) {
    return 'Existing-order sync is off or the app is not configured.';
  }
  // "Only when re-synced manually" means nothing reaches ShipStation unless the merchant
  // asks for it, and that includes the orders that were open at setup.
  if (settings.push_trigger === 'manual') {
    return 'Orders are only sent on request, so existing orders are not sent automatically.';
  }
  return null;
}

/**
 * Starts sending the orders that are open but not yet in ShipStation, unless a run is
 * already pending. With `firstOnly`, starts one only when none has ever run. Returns
 * whether a run was started.
 */
export async function startBackfill(
  req: SwellRequest,
  settings: ShipStationSettings,
  { firstOnly = false }: { firstOnly?: boolean } = {},
): Promise<boolean> {
  if (backfillOff(settings)) {
    return false;
  }

  const existing = (await req.swell.get(backfillsPath(req), {
    where: firstOnly ? {} : { status: 'pending' },
    limit: 1,
    fields: 'id',
  } as any)) as { results?: unknown[] } | null;
  if (existing?.results?.length) {
    return false;
  }

  // Due now: the first batch runs right away
  await req.swell.post(backfillsPath(req), {
    status: 'pending',
    date_next_run: new Date().toISOString(),
  });
  return true;
}

/** Schedules again a pending run whose scheduled batch was lost, e.g. to a redeploy. */
export async function rearmBackfills(req: SwellRequest): Promise<number> {
  const pending = (await req.swell.get(backfillsPath(req), {
    where: { status: 'pending' },
    limit: 5,
    fields: 'id,date_next_run',
  } as any)) as { results?: Array<{ id: string; date_next_run?: string | null }> } | null;

  const cutoff = Date.now() - OVERDUE_GRACE_MS;
  let rearmed = 0;
  for (const job of pending?.results ?? []) {
    const due = job.date_next_run ? Date.parse(job.date_next_run) : NaN;
    if (Number.isNaN(due) || due < cutoff) {
      await req.swell.put(`${backfillsPath(req)}/${job.id}`, {
        date_next_run: new Date().toISOString(),
      });
      rearmed++;
    }
  }
  return rearmed;
}
