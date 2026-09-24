import { afterEach, describe, expect, it, vi } from 'vitest';
import reconcile from '../../functions/webhook-reconcile';
import { post as setupPost } from '../../functions/setup';
import { createMockRequest } from '../helpers/mock-request';

const STORE = 'test-store';

function webhookList() {
  return {
    webhooks: [
      { WebHookID: 11, HookType: 'SHIP_NOTIFY', Name: `swell-${STORE}-SHIP_NOTIFY`, Url: 'https://x' },
      {
        WebHookID: 12,
        HookType: 'ITEM_SHIP_NOTIFY',
        Name: 'renamed by hand',
        Url: `https://${STORE}.swell.store/functions/0123456789abcdef01234567/shipstation-webhook?secret=s`,
      },
      // Another integration on the same ShipStation account: never ours to delete.
      { WebHookID: 99, HookType: 'SHIP_NOTIFY', Name: 'Other channel', Url: 'https://other.example/hook' },
    ],
  };
}

function stubShipStation() {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET' && String(url).endsWith('/webhooks')) {
      return new Response(JSON.stringify(webhookList()), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function deletedIds(fetchMock: ReturnType<typeof stubShipStation>): string[] {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'DELETE')
    .map(([url]) => String(url).split('/').pop() ?? '');
}

function request(settings: Record<string, unknown>, body: Record<string, unknown> = {}) {
  const req = createMockRequest({
    store: { id: STORE } as any,
    swell: {
      settings: vi.fn(async () => ({
        shipstation: { api_key: 'key', api_secret: 'secret', webhook_secret: 's', ...settings },
      })),
      get: vi.fn(async () => ({ results: [] })),
    },
  });
  req.body = body;
  return req;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('webhook teardown', () => {
  it('removes only the subscriptions this app owns when the app is switched off', async () => {
    const fetchMock = stubShipStation();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await reconcile(request({ enabled: false }));

    expect(deletedIds(fetchMock).sort()).toEqual(['11', '12']);
  });

  it('removes them on request from setup, before an uninstall', async () => {
    const fetchMock = stubShipStation();

    const result: any = await setupPost(request({ enabled: true }, { action: 'remove_webhooks' }));

    expect(result.ok).toBe(true);
    expect(deletedIds(fetchMock).sort()).toEqual(['11', '12']);
  });
});
