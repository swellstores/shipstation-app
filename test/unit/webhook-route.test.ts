import { afterEach, describe, expect, it, vi } from 'vitest';
import { post } from '../../functions/shipstation-webhook';
import { createMockRequest } from '../helpers/mock-request';
import { order, shipStationShipment } from '../helpers/fixtures';

const SECRET = 'a-long-enough-secret';

function appSettings(overrides: Record<string, unknown> = {}) {
  return {
    shipstation: {
      enabled: true,
      api_key: 'key',
      api_secret: 'secret',
      webhook_secret: SECRET,
      create_shipments: true,
      allow_test_payload: true,
      ...overrides,
    },
  };
}

function request(options: {
  query?: Record<string, string>;
  body?: Record<string, any>;
  settings?: Record<string, unknown>;
  orders?: Record<string, any> | null;
}) {
  const req = createMockRequest({
    query: options.query ?? { secret: SECRET },
    data: options.body ?? {},
    swell: {
      settings: vi.fn(async () => appSettings(options.settings)),
      get: vi.fn(async (url: string) => {
        if (url === '/orders/{id}') {
          return options.orders === undefined ? order() : options.orders;
        }
        if (url === '/shipments') {
          return { results: [] };
        }
        return null;
      }),
      post: vi.fn(async (_url: string, body: Record<string, any>) => ({ id: 'ship_1', ...body })),
      put: vi.fn(async () => ({})),
    },
  });
  // createMockRequest stringifies data into the request body; the handler reads req.body.
  req.body = options.body ?? {};
  return req;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('shipstation-webhook route', () => {
  it('rejects a delivery with the wrong secret', async () => {
    const req = request({ query: { secret: 'wrong' }, body: { resource_type: 'SHIP_NOTIFY' } });

    await expect(post(req)).rejects.toMatchObject({ status: 401 });
  });

  it('accepts a real delivery with no secret, because it fetches the shipments itself', async () => {
    // What ShipStation's POST looks like on Swell today: the platform drops the query
    // string when there is a body (Asana 1218816382065204). The shipments come from
    // ShipStation's API with the merchant's credentials, not from the caller.
    const fetchMock = vi.fn(
      async (_url: string) =>
        new Response(JSON.stringify({ shipments: [shipStationShipment()], pages: 1 }), {
          status: 200,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const req = request({
      query: {},
      body: {
        resource_type: 'SHIP_NOTIFY',
        resource_url: 'https://ssapi12.shipstation.com/shipments?batchId=42',
      },
      settings: { allow_test_payload: false },
    });

    await expect(post(req)).resolves.toMatchObject({ ok: true, received: 1, created: 1 });
    expect(fetchMock.mock.calls[0][0]).toContain('https://ssapi12.shipstation.com/shipments');
  });

  it('refuses inline test shipments without the secret, since nothing else vouches for them', async () => {
    const req = request({
      query: {},
      body: { resource_type: 'SHIP_NOTIFY', shipments: [shipStationShipment()] },
    });

    await expect(post(req)).rejects.toMatchObject({ status: 401 });
  });

  it('accepts the secret from the body, which is where admin-API invocations put it', async () => {
    const req = request({
      query: {},
      body: {
        secret: SECRET,
        resource_type: 'SHIP_NOTIFY',
        shipments: [shipStationShipment()],
      },
    });

    await expect(post(req)).resolves.toMatchObject({ ok: true, created: 1 });
  });

  it('still rejects a body-supplied secret that does not match', async () => {
    const req = request({
      query: {},
      body: { secret: 'wrong', resource_type: 'SHIP_NOTIFY' },
    });

    await expect(post(req)).rejects.toMatchObject({ status: 401 });
  });

  it('acknowledges events it does not act on so ShipStation keeps the subscription', async () => {
    const req = request({ body: { resource_type: 'ORDER_NOTIFY' } });

    await expect(post(req)).resolves.toMatchObject({ ok: true });
  });

  it('reports shipment sync being switched off without failing the delivery', async () => {
    const req = request({
      body: { resource_type: 'SHIP_NOTIFY' },
      settings: { create_shipments: false },
    });

    await expect(post(req)).resolves.toMatchObject({ ok: true });
  });

  it('records shipments supplied inline when test payloads are enabled', async () => {
    const req = request({
      body: { resource_type: 'SHIP_NOTIFY', shipments: [shipStationShipment()] },
    });

    await expect(post(req)).resolves.toMatchObject({ ok: true, received: 1, created: 1 });
  });

  it('requires a resource_url when test payloads are disabled', async () => {
    const req = request({
      body: { resource_type: 'SHIP_NOTIFY', shipments: [shipStationShipment()] },
      settings: { allow_test_payload: false },
    });

    await expect(post(req)).rejects.toMatchObject({ status: 400 });
  });

  it('answers with a retryable status when nothing could be recorded', async () => {
    const req = request({
      body: { resource_type: 'SHIP_NOTIFY', shipments: [shipStationShipment()] },
      orders: null,
    });

    const response = (await post(req)) as Response;

    expect(response.status).toBe(503);
  });
});
