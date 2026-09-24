import { afterEach, describe, expect, it, vi } from 'vitest';
import backfill, { BATCH_SIZE } from '../../functions/order-backfill';
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

function request(options: { settings?: Record<string, unknown>; openOrders?: string[] } = {}) {
  const get = vi.fn(async (url: string, _query?: Record<string, any>) => {
    if (url === '/orders') {
      return { results: (options.openOrders ?? []).map((id) => ({ id })) };
    }
    if (url === '/orders/{id}') {
      return order();
    }
    return null;
  });
  const req = createMockRequest({
    appId: 'shipstation',
    swell: {
      settings: vi.fn(async () => appSettings(options.settings)),
      get,
      put: vi.fn(async () => ({})),
    },
  });
  return { req, get };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('order-backfill cron', () => {
  it("asks only for native's first-sync set that this app has not synced yet", async () => {
    const { req, get } = request();

    await backfill(req);

    const [, query] = get.mock.calls[0];
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
    const { req } = request({ openOrders: ['order_a', 'order_b'] });

    const result: any = await backfill(req);

    expect(result).toMatchObject({ ok: true, pushed: 2, attempted: 2 });
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes('/orders/createorder'))).toBe(
      true,
    );
  });

  it('goes quiet once no open orders are left', async () => {
    const { req } = request({ openOrders: [] });
    await expect(backfill(req)).resolves.toMatchObject({ ok: true, pushed: 0 });
  });

  it('does nothing when the merchant has turned existing-order sync off', async () => {
    const { req, get } = request({ settings: { sync_existing: false }, openOrders: ['order_a'] });

    await expect(backfill(req)).resolves.toMatchObject({ ignored: expect.any(String) });
    expect(get).not.toHaveBeenCalled();
  });

  it('does nothing while the app is switched off or has no credentials', async () => {
    for (const settings of [{ enabled: false }, { api_key: '' }]) {
      const { req, get } = request({ settings, openOrders: ['order_a'] });
      await backfill(req);
      expect(get).not.toHaveBeenCalled();
    }
  });
});
