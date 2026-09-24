import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShipStationClient, ShipStationError } from '../../functions/lib/shipstation';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function client() {
  return new ShipStationClient('key', 'secret');
}

afterEach(() => {
  vi.restoreAllMocks();
  // The workers pool shares one runtime across test files, so a stubbed fetch would
  // otherwise leak into the integration tests that talk to the real API.
  vi.unstubAllGlobals();
});

describe('ShipStationClient', () => {
  it('sends basic auth built from the key and secret', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { orderId: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    await client().getOrder(1);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ssapi.shipstation.com/orders/1');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${btoa('key:secret')}`,
    );
  });

  it('treats 5xx and 429 as retryable and 4xx as permanent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, { Message: 'boom' })));
    await expect(client().getOrder(1)).rejects.toMatchObject({
      retryable: true,
      status: 500,
    });

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(422, { Message: 'bad address' })));
    await expect(client().getOrder(1)).rejects.toMatchObject({
      retryable: false,
      status: 422,
    });
  });

  it('surfaces the ShipStation error message rather than a bare status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(400, { ExceptionMessage: 'orderNumber is required' })),
    );

    await expect(client().getOrder(1)).rejects.toThrow(/orderNumber is required/);
  });

  it('waits once and retries when ShipStation asks for a short pause', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { Message: 'slow down' }, { 'Retry-After': '1' }))
      .mockResolvedValueOnce(jsonResponse(200, { orderId: 7 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await client().getOrder(1);

    expect(result?.orderId).toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up on a long rate-limit pause so the platform can redeliver instead', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(429, { Message: 'slow down' }, { 'Retry-After': '120' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(client().getOrder(1)).rejects.toMatchObject({ retryable: true, status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a network failure as retryable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );

    await expect(client().getOrder(1)).rejects.toMatchObject({ retryable: true });
  });

  it('refuses to fetch a webhook resource from another host', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { shipments: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(client().fetchShipments('https://evil.example.com/shipments')).rejects.toThrow(
      /Refusing to fetch/,
    );
    await expect(client().fetchShipments('not a url')).rejects.toBeInstanceOf(ShipStationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches from the numbered API hosts ShipStation actually sends', async () => {
    // Real SHIP_NOTIFY deliveries point at hosts like ssapi12.shipstation.com. Accepting
    // only the bare host rejected every one of them.
    const fetchMock = vi.fn(async () => jsonResponse(200, { shipments: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await client().fetchShipments('https://ssapi12.shipstation.com/shipments?batchId=1');
    await client().fetchShipments('https://ssapi.shipstation.com/shipments?batchId=1');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses look-alike hosts and anything that is not a shipments listing', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { shipments: [] }));
    vi.stubGlobal('fetch', fetchMock);

    for (const url of [
      'https://ssapi12.shipstation.com.evil.example/shipments',
      'https://ssapix.shipstation.com/shipments',
      'http://ssapi12.shipstation.com/shipments',
      'https://ssapi12.shipstation.com/accounts/listtags',
    ]) {
      await expect(client().fetchShipments(url)).rejects.toThrow(/Refusing to fetch/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks for shipment items, which SHIP_NOTIFY resource URLs leave off by default', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { shipments: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await client().fetchShipments(
      'https://ssapi.shipstation.com/shipments?batchId=1&includeShipmentItems=False',
    );

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain('includeShipmentItems=True');
    expect(url).not.toContain('includeShipmentItems=False');
  });

  it('reads the webhook list out of its envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { webhooks: [{ WebHookID: 5 }] })),
    );

    await expect(client().listWebhooks()).resolves.toEqual([{ WebHookID: 5 }]);
  });
});
