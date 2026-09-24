import { afterEach, describe, expect, it, vi } from 'vitest';
import orderPush from '../../functions/order-push';
import orderCancel from '../../functions/order-cancel';
import { pushOrder } from '../../functions/lib/push';
import { ShipStationSettings } from '../../functions/lib/settings';
import { createMockRequest } from '../helpers/mock-request';
import { order, orderItem } from '../helpers/fixtures';

function settings(overrides: Partial<ShipStationSettings> = {}): ShipStationSettings {
  return {
    enabled: true,
    api_key: 'key',
    api_secret: 'secret',
    store_id: '',
    push_trigger: 'paid',
    order_prefix: '',
    sync_updates: true,
    sync_cancels: true,
    sync_existing: true,
    webhook_secret: 'a-long-enough-secret',
    callback_url: '',
    create_shipments: true,
    allow_test_payload: false,
    ...overrides,
  };
}

function appSettings(overrides: Partial<ShipStationSettings> = {}) {
  return { shipstation: settings(overrides) };
}

function swellStub(record: Record<string, any> | null = order()) {
  return {
    settings: vi.fn(async () => appSettings()),
    get: vi.fn(async (url: string) => {
      if (url === '/orders/{id}') {
        return record;
      }
      if (url === '/settings/shipments') {
        return { weight_unit: 'lb' };
      }
      return null;
    }),
    put: vi.fn(async (_url: string, _body: Record<string, any>) => ({})),
    post: vi.fn(async (_url: string, _body: Record<string, any>) => ({})),
  };
}

function shipStationResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.restoreAllMocks();
  // The workers pool shares one runtime across test files, so a stubbed fetch would
  // otherwise leak into the integration tests that talk to the real API.
  vi.unstubAllGlobals();
});

describe('pushOrder', () => {
  it('records the ShipStation ids and clears the error on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => shipStationResponse(200, { orderId: 4242 })),
    );
    const swell = swellStub();
    const req = createMockRequest({ swell });

    const result = await pushOrder(req, settings(), 'order_1');

    expect(result).toMatchObject({ ok: true, action: 'pushed', shipstationOrderId: 4242 });
    const [url, body] = swell.put.mock.calls[0];
    expect(url).toBe('/orders/order_1');
    expect(body.$app.shipstation).toMatchObject({
      sync_status: 'synced',
      shipstation_order_id: 4242,
      shipstation_order_number: 'BVR100042',
      last_error: null,
      resync_requested: false,
    });
  });

  it('writes only inside its own $app namespace so it cannot retrigger itself', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => shipStationResponse(200, { orderId: 1 })),
    );
    const swell = swellStub();
    const req = createMockRequest({ swell });

    await pushOrder(req, settings(), 'order_1');

    expect(Object.keys(swell.put.mock.calls[0][1])).toEqual(['$app']);
  });

  it('records a permanent failure without asking for a retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => shipStationResponse(422, { Message: 'shipTo postalCode is required' })),
    );
    const swell = swellStub();
    const req = createMockRequest({ swell });

    const result = await pushOrder(req, settings(), 'order_1');

    expect(result).toMatchObject({ ok: false, action: 'error', retryable: false });
    expect(swell.put.mock.calls[0][1].$app.shipstation).toMatchObject({
      sync_status: 'error',
      last_error: expect.stringContaining('postalCode'),
    });
  });

  it('asks for a retry when ShipStation is briefly unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => shipStationResponse(503, { Message: 'temporarily unavailable' })),
    );
    const req = createMockRequest({ swell: swellStub() });

    const result = await pushOrder(req, settings(), 'order_1');

    expect(result).toMatchObject({ ok: false, retryable: true });
  });

  it('reports missing credentials once instead of retrying forever', async () => {
    const req = createMockRequest({ swell: swellStub() });

    const result = await pushOrder(req, settings({ api_key: '', api_secret: '' }), 'order_1');

    expect(result).toMatchObject({
      ok: false,
      action: 'skipped_not_configured',
      retryable: false,
    });
  });

  it('leaves an order alone when ShipStation has already shipped it', async () => {
    const fetchMock = vi.fn(async () =>
      shipStationResponse(200, { orderId: 10, orderStatus: 'shipped' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const shipped = order();
    shipped.$app = { shipstation: { order_key: shipped.id, shipstation_order_id: 10 } };
    const swell = swellStub(shipped);
    const req = createMockRequest({ swell });

    const result = await pushOrder(req, settings(), 'order_1', {
      requireExisting: true,
      guardShipped: true,
    });

    expect(result.action).toBe('skipped_already_shipped');
    // Only the status probe was made; no createorder call followed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(swell.put.mock.calls[0][1].$app.shipstation).toMatchObject({ sync_status: 'skipped' });
  });

  it('treats an already-cancelled ShipStation order as a successful cancellation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => shipStationResponse(200, { orderId: 10, orderStatus: 'cancelled' })),
    );
    const pushed = order();
    pushed.$app = { shipstation: { order_key: pushed.id, shipstation_order_id: 10 } };
    const swell = swellStub(pushed);
    const req = createMockRequest({ swell });

    const result = await pushOrder(req, settings(), 'order_1', {
      requireExisting: true,
      guardShipped: true,
      statusOverride: 'cancelled',
    });

    expect(result).toMatchObject({ ok: true, action: 'pushed' });
    expect(swell.put.mock.calls[0][1].$app.shipstation.sync_status).toBe('canceled');
  });

  it('does not create an order ShipStation never had when only an update was requested', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const req = createMockRequest({ swell: swellStub() });

    const result = await pushOrder(req, settings(), 'order_1', { requireExisting: true });

    expect(result.action).toBe('skipped_never_pushed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps digital-only orders out of ShipStation', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const digital = order({ items: [orderItem({ delivery: 'giftcard' })] });
    const swell = swellStub(digital);
    const req = createMockRequest({ swell });

    const result = await pushOrder(req, settings(), 'order_1');

    expect(result.action).toBe('skipped_no_items');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(swell.put.mock.calls[0][1].$app.shipstation.sync_status).toBe('skipped');
  });

  it('reports a missing order rather than throwing', async () => {
    const req = createMockRequest({ swell: swellStub(null) });

    const result = await pushOrder(req, settings(), 'missing');

    expect(result).toMatchObject({ ok: false, action: 'error' });
    expect(result.message).toContain('missing');
  });
});

describe('order-push trigger selection', () => {
  function pushRequest(eventType: string, overrides: Partial<ShipStationSettings> = {}) {
    const fetchMock = vi.fn(async () => shipStationResponse(200, { orderId: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    const swell = swellStub();
    swell.settings = vi.fn(async () => appSettings(overrides));
    const req = createMockRequest({
      swell,
      data: { id: 'order_1', $event: { type: eventType, data: {} } },
    });
    return { req, fetchMock };
  }

  it('pushes on the configured trigger only', async () => {
    const paid = pushRequest('order.paid', { push_trigger: 'paid' });
    await orderPush(paid.req);
    expect(paid.fetchMock).toHaveBeenCalled();

    const submitted = pushRequest('order.submitted', { push_trigger: 'paid' });
    await orderPush(submitted.req);
    expect(submitted.fetchMock).not.toHaveBeenCalled();
  });

  it('pushes on submission when that is the configured trigger', async () => {
    const submitted = pushRequest('order.submitted', { push_trigger: 'submitted' });
    await orderPush(submitted.req);
    expect(submitted.fetchMock).toHaveBeenCalled();
  });

  it('pushes nothing automatically when the trigger is manual', async () => {
    const manual = pushRequest('order.paid', { push_trigger: 'manual' });
    await orderPush(manual.req);
    expect(manual.fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing while the app is switched off', async () => {
    const off = pushRequest('order.paid', { enabled: false });
    await orderPush(off.req);
    expect(off.fetchMock).not.toHaveBeenCalled();
  });
});

describe('order-cancel', () => {
  it('sends the cancellation as a cancelled order status', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(shipStationResponse(200, { orderId: 10, orderStatus: 'awaiting_shipment' }))
      .mockResolvedValueOnce(shipStationResponse(200, { orderId: 10 }));
    vi.stubGlobal('fetch', fetchMock);

    const pushed = order();
    pushed.$app = { shipstation: { order_key: pushed.id, shipstation_order_id: 10 } };
    const swell = swellStub(pushed);
    const req = createMockRequest({ swell, data: { id: 'order_1', $event: { type: 'order.canceled', data: {} } } });

    await orderCancel(req);

    const createCall = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(createCall[0]).toContain('/orders/createorder');
    expect(JSON.parse(createCall[1].body as string).orderStatus).toBe('cancelled');
    expect(swell.put.mock.calls[0][1].$app.shipstation.sync_status).toBe('canceled');
  });
});
