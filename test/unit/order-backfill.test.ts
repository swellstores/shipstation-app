import { afterEach, describe, expect, it, vi } from 'vitest';
import backfill, { BATCH_SIZE } from '../../functions/order-backfill';
import { BACKFILL_INTERVAL_MS, rearmBackfills, startBackfill } from '../../functions/lib/backfill';
import { getSettings } from '../../functions/lib/settings';
import { createMockRequest } from '../helpers/mock-request';
import { order } from '../helpers/fixtures';

function appSettings(overrides: Record<string, unknown> = {}) {
  return {
    shipstation: {
      enabled: true,
      api_key: 'key',
      api_secret: 'secret',
      sync_existing: true,
      ...overrides,
    },
  };
}

const JOB_PATH = '/apps/shipstation/backfills/job_1';

function request(
  options: {
    settings?: Record<string, unknown>;
    openOrders?: string[];
    job?: Record<string, unknown> | null;
  } = {},
) {
  const job = options.job === undefined ? { id: 'job_1', status: 'pending', pushed_count: 2 } : options.job;
  const get = vi.fn(async (url: string, _query?: Record<string, any>) => {
    if (url === JOB_PATH) {
      return job;
    }
    if (url === '/orders') {
      return { results: (options.openOrders ?? []).map((id) => ({ id })) };
    }
    if (url === '/orders/{id}') {
      return order();
    }
    return null;
  });
  const put = vi.fn(async (_url: string, _data: Record<string, any>) => ({}));
  const req = createMockRequest({
    appId: 'shipstation',
    data: { id: 'job_1' },
    swell: {
      settings: vi.fn(async () => appSettings(options.settings)),
      get,
      put,
    },
  });
  const orderQueries = () => get.mock.calls.filter(([url]) => url === '/orders');
  const jobWrites = () => put.mock.calls.filter(([url]) => url === JOB_PATH).map(([, data]) => data);
  return { req, get, put, orderQueries, jobWrites };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('order-backfill', () => {
  it("asks only for native's first-sync set that this app has not synced yet", async () => {
    const { req, orderQueries } = request();

    await backfill(req);

    const [, query] = orderQueries()[0];
    expect(query?.where).toMatchObject({
      paid: true,
      canceled: { $ne: true },
      closed: { $ne: true },
      item_quantity_deliverable: { $gt: 0 },
      '$app.shipstation.sync_status': { $exists: false },
    });
    expect(query?.limit).toBe(BATCH_SIZE);
    expect(query?.sort).toBe('date_created asc');
  });

  it('pushes each open order to ShipStation', async () => {
    const fetchMock = vi.fn(
      async (_url: string) => new Response(JSON.stringify({ orderId: 1 }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { req, jobWrites } = request({ openOrders: ['order_a', 'order_b'] });

    const before = Date.now();
    const result: any = await backfill(req);

    expect(result).toMatchObject({ ok: true, pushed: 2, attempted: 2 });
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes('/orders/createorder'))).toBe(
      true,
    );
    // Counts add up, and the next batch is scheduled a minute out
    const [write] = jobWrites();
    expect(write).toMatchObject({ pushed_count: 4, attempted_count: 2 });
    expect(Date.parse(write.date_next_run)).toBeGreaterThanOrEqual(before + BACKFILL_INTERVAL_MS);
  });

  it('finishes the run once no open orders are left', async () => {
    const { req, jobWrites } = request({ openOrders: [] });
    await expect(backfill(req)).resolves.toMatchObject({ ok: true, pushed: 0 });
    expect(jobWrites()).toEqual([
      expect.objectContaining({ status: 'done', date_next_run: null, result: 'No existing orders left to send.' }),
    ]);
  });

  it('does nothing for a run that already finished', async () => {
    const { req, orderQueries, put } = request({ job: { id: 'job_1', status: 'done' }, openOrders: ['order_a'] });

    await expect(backfill(req)).resolves.toMatchObject({ ignored: expect.any(String) });
    expect(orderQueries()).toHaveLength(0);
    expect(put).not.toHaveBeenCalled();
  });

  it('finishes without sending when the merchant has turned existing-order sync off', async () => {
    const { req, orderQueries, jobWrites } = request({
      settings: { sync_existing: false },
      openOrders: ['order_a'],
    });

    await expect(backfill(req)).resolves.toMatchObject({ ignored: expect.any(String) });
    expect(orderQueries()).toHaveLength(0);
    expect(jobWrites()).toEqual([expect.objectContaining({ status: 'done', date_next_run: null })]);
  });

  it('sends nothing when orders are only pushed on request', async () => {
    // Send existing orders defaults on, so a merchant who picks "Only when re-synced
    // manually" would otherwise still get every open paid order sent.
    const { req, orderQueries } = request({ settings: { push_trigger: 'manual' }, openOrders: ['order_a'] });

    await expect(backfill(req)).resolves.toMatchObject({ ignored: expect.any(String) });
    expect(orderQueries()).toHaveLength(0);
  });

  it('still sends existing orders with the submitted trigger', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ orderId: 1 }), { status: 200 })),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { req } = request({ settings: { push_trigger: 'submitted' }, openOrders: ['order_a'] });

    await expect(backfill(req)).resolves.toMatchObject({ pushed: 1 });
  });

  it('does nothing while the app is switched off or has no credentials', async () => {
    for (const settings of [{ enabled: false }, { api_key: '' }]) {
      const { req, orderQueries } = request({ settings, openOrders: ['order_a'] });
      await backfill(req);
      expect(orderQueries()).toHaveLength(0);
    }
  });
});

describe('starting and re-arming existing-order syncs', () => {
  function store(jobs: Array<Record<string, any>>, settings: Record<string, unknown> = {}) {
    const get = vi.fn(async (_url: string, query: Record<string, any> = {}) => ({
      results: jobs.filter((job) => !query.where?.status || job.status === query.where.status),
    }));
    const post = vi.fn(async (_url: string, data: Record<string, any>) => data);
    const put = vi.fn(async (_url: string, data: Record<string, any>) => data);
    const req = createMockRequest({
      appId: 'shipstation',
      swell: { settings: vi.fn(async () => appSettings(settings)), get, post, put },
    });
    return { req, get, post, put };
  }

  it('starts a run that is due right away', async () => {
    const { req, post } = store([]);
    await expect(startBackfill(req, await getSettings(req))).resolves.toBe(true);
    expect(post).toHaveBeenCalledWith('/apps/shipstation/backfills', {
      status: 'pending',
      date_next_run: expect.any(String),
    });
    expect(Date.parse(post.mock.calls[0][1].date_next_run)).toBeLessThanOrEqual(Date.now());
  });

  it('does not start a second run while one is pending', async () => {
    const { req, post } = store([{ id: 'a', status: 'pending' }]);
    await expect(startBackfill(req, await getSettings(req))).resolves.toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('starts again on request once the last run finished, but not as a first run', async () => {
    const done = [{ id: 'a', status: 'done' }];
    const again = store(done);
    await expect(startBackfill(again.req, await getSettings(again.req))).resolves.toBe(true);
    const first = store(done);
    await expect(startBackfill(first.req, await getSettings(first.req), { firstOnly: true })).resolves.toBe(false);
    expect(first.post).not.toHaveBeenCalled();
  });

  it('starts nothing when existing orders are not sent automatically', async () => {
    for (const settings of [{ sync_existing: false }, { push_trigger: 'manual' }, { enabled: false }]) {
      const { req, get, post } = store([], settings);
      await expect(startBackfill(req, await getSettings(req))).resolves.toBe(false);
      expect(get).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
    }
  });

  it('re-arms pending runs whose batch is overdue or was never scheduled', async () => {
    const soon = new Date(Date.now() + 60_000).toISOString();
    const { req, put } = store([
      { id: 'late', status: 'pending', date_next_run: new Date(Date.now() - 3_600_000).toISOString() },
      { id: 'unscheduled', status: 'pending' },
      { id: 'on_time', status: 'pending', date_next_run: soon },
    ]);

    await expect(rearmBackfills(req)).resolves.toBe(2);
    expect(put.mock.calls.map(([url]) => url)).toEqual([
      '/apps/shipstation/backfills/late',
      '/apps/shipstation/backfills/unscheduled',
    ]);
  });
});
