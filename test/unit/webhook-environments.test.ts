import { afterEach, describe, expect, it, vi } from 'vitest';
import reconcile from '../../functions/webhook-reconcile';
import { reconcileWebhooks, removeWebhooks } from '../../functions/lib/webhooks';
import { getSettings } from '../../functions/lib/settings';
import { orderKeyFor, parseOrderKey, swellEnvironment } from '../../functions/lib/environment';
import { createMockRequest } from '../helpers/mock-request';

const STORE = 'acme';
const LIVE_URL = `https://${STORE}.swell.store/functions/0123456789abcdef01234567/shipstation-webhook?secret=s`;
const TUNNEL = 'https://tunnel.example/hook';

/**
 * One ShipStation account shared by store `acme`'s live and test environments, plus a
 * neighbouring store whose id starts with ours and another sales channel.
 */
function sharedAccount() {
  return [
    // Live, named by every version so far.
    { WebHookID: 1, HookType: 'SHIP_NOTIFY', Name: `swell-${STORE}-SHIP_NOTIFY`, Url: LIVE_URL },
    { WebHookID: 2, HookType: 'ITEM_SHIP_NOTIFY', Name: `swell-${STORE}-ITEM_SHIP_NOTIFY`, Url: LIVE_URL },
    // The test environment's, registered against a tunnel.
    { WebHookID: 3, HookType: 'SHIP_NOTIFY', Name: `swell-${STORE}.test-SHIP_NOTIFY`, Url: `${TUNNEL}?secret=t` },
    { WebHookID: 4, HookType: 'ITEM_SHIP_NOTIFY', Name: `swell-${STORE}.test-ITEM_SHIP_NOTIFY`, Url: `${TUNNEL}?secret=t` },
    // Store `acme-test`'s live webhook, which an unanchored prefix match would claim.
    {
      WebHookID: 5,
      HookType: 'SHIP_NOTIFY',
      Name: `swell-${STORE}-test-SHIP_NOTIFY`,
      Url: 'https://acme-test.swell.store/functions/0123456789abcdef01234567/shipstation-webhook',
    },
    { WebHookID: 9, HookType: 'SHIP_NOTIFY', Name: 'Other channel', Url: 'https://other.example/hook' },
  ];
}

function stubShipStation(webhooks = sharedAccount()) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET' && String(url).endsWith('/webhooks')) {
      return new Response(JSON.stringify({ webhooks }), { status: 200 });
    }
    if (String(url).endsWith('/webhooks/subscribe')) {
      return new Response(JSON.stringify({ id: 77 }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function deleted(fetchMock: ReturnType<typeof stubShipStation>): number[] {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'DELETE')
    .map(([url]) => Number(String(url).split('/').pop()))
    .sort();
}

function subscribed(fetchMock: ReturnType<typeof stubShipStation>): Array<Record<string, any>> {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith('/webhooks/subscribe'))
    .map(([, init]) => JSON.parse(String(init?.body)));
}

function request(
  environmentId: string | null | undefined,
  settings: Record<string, unknown> = {},
) {
  const req = createMockRequest({
    store: { id: STORE } as any,
    swell: {
      settings: vi.fn(async () => ({
        shipstation: {
          enabled: true,
          api_key: 'key',
          api_secret: 'secret',
          webhook_secret: 's',
          ...settings,
        },
      })),
      get: vi.fn(async () => ({
        results: [
          {
            name: 'shipstation-webhook',
            description: 'Receive ShipStation shipment notifications and create Swell shipments',
            app_id: '0123456789abcdef01234567',
          },
        ],
      })),
    },
  });
  if (environmentId !== undefined) {
    req.logParams = { client_id: STORE, environment_id: environmentId };
  }
  return req;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('environment detection', () => {
  it('reads the environment from the request log the platform sends', () => {
    expect(swellEnvironment(request(null))).toEqual({ id: null, known: true });
    expect(swellEnvironment(request('test'))).toEqual({ id: 'test', known: true });
    expect(swellEnvironment(request(undefined))).toEqual({ id: null, known: false });
  });

  it('keeps live order keys as the bare Swell id and prefixes the rest', () => {
    const id = '6650f1a2b3c4d5e6f7a8b9c0';
    expect(orderKeyFor({ id: null, known: true }, id)).toBe(id);
    expect(orderKeyFor({ id: 'test', known: true }, id)).toBe(`test:${id}`);
    expect(parseOrderKey(id)).toEqual({ environment: 'live', orderId: id });
    expect(parseOrderKey(`test:${id}`)).toEqual({ environment: 'test', orderId: id });
    expect(parseOrderKey('amazon-123')).toBeNull();
    expect(parseOrderKey(null)).toBeNull();
  });
});

describe('webhooks shared by live and test on one ShipStation account', () => {
  it("a switched-off test environment removes only its own webhooks, never live's", async () => {
    const fetchMock = stubShipStation();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await reconcile(request('test', { enabled: false }));

    expect(deleted(fetchMock)).toEqual([3, 4]);
  });

  it("switching live off leaves the test environment's and the neighbouring store's alone", async () => {
    const fetchMock = stubShipStation();

    const result = await removeWebhooks(request(null), await getSettings(request(null)));

    expect(result.ok).toBe(true);
    expect(deleted(fetchMock)).toEqual([1, 2]);
  });

  it('live keeps the webhooks it registered under the original names', async () => {
    const fetchMock = stubShipStation();
    const req = request(null);

    const result = await reconcileWebhooks(req, await getSettings(req));

    expect(result.outcomes.map((outcome) => outcome.action)).toEqual(['kept', 'kept']);
    expect(deleted(fetchMock)).toEqual([]);
    expect(subscribed(fetchMock)).toEqual([]);
  });

  it('live adopts a webhook an older test environment registered at the live address', async () => {
    // Before 1.0.2 both environments used live-style names, so live owns these now: it
    // replaces the stale one in place and leaves no duplicate.
    const fetchMock = stubShipStation([
      { WebHookID: 1, HookType: 'SHIP_NOTIFY', Name: `swell-${STORE}-SHIP_NOTIFY`, Url: LIVE_URL },
      {
        WebHookID: 6,
        HookType: 'SHIP_NOTIFY',
        Name: `swell-${STORE}-SHIP_NOTIFY`,
        Url: LIVE_URL.replace('secret=s', 'secret=old'),
      },
      {
        WebHookID: 2,
        HookType: 'ITEM_SHIP_NOTIFY',
        Name: `swell-${STORE}-ITEM_SHIP_NOTIFY`,
        Url: LIVE_URL.replace('secret=s', 'secret=old'),
      },
    ]);
    const req = request(null);

    const result = await reconcileWebhooks(req, await getSettings(req));

    expect(result.ok).toBe(true);
    expect(deleted(fetchMock)).toEqual([2, 6]);
    expect(subscribed(fetchMock)).toEqual([
      expect.objectContaining({ event: 'ITEM_SHIP_NOTIFY', friendly_name: `swell-${STORE}-ITEM_SHIP_NOTIFY` }),
    ]);
  });

  it('the test environment registers nothing at the live address', async () => {
    // Public routes only serve live, so a test subscription there would hand live a
    // second copy of every notification. Leftovers from an old override are removed.
    const fetchMock = stubShipStation();
    const req = request('test');

    const result = await reconcileWebhooks(req, await getSettings(req));

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/live environment/);
    expect(subscribed(fetchMock)).toEqual([]);
    expect(deleted(fetchMock)).toEqual([3, 4]);
  });

  it('the test environment registers its own names when given a callback override', async () => {
    const fetchMock = stubShipStation([]);
    const req = request('test', { callback_url: TUNNEL });

    await reconcileWebhooks(req, await getSettings(req));

    expect(subscribed(fetchMock).map((body) => body.friendly_name)).toEqual([
      `swell-${STORE}.test-SHIP_NOTIFY`,
      `swell-${STORE}.test-ITEM_SHIP_NOTIFY`,
    ]);
  });

  it('touches nothing when the environment cannot be told', async () => {
    const fetchMock = stubShipStation();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await reconcile(request(undefined, { enabled: false }));
    const req = request(undefined);
    const result = await reconcileWebhooks(req, await getSettings(req));

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
