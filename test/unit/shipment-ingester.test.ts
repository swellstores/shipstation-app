import { describe, expect, it, vi } from 'vitest';
import {
  OrderContext,
  buildShipmentItems,
  carrierName,
  indexOrderItems,
  ingestShipments,
  serviceName,
} from '../../functions/lib/shipment-ingester';
import { ShipStationShipment } from '../../functions/lib/shipstation';
import { ShipStationSettings } from '../../functions/lib/settings';
import { createMockRequest } from '../helpers/mock-request';
import { order, orderItem, shipStationShipment } from '../helpers/fixtures';

function context(source: Record<string, any>): OrderContext {
  return {
    order: source,
    byShipStationId: new Map(),
    created: 0,
    ...indexOrderItems(source),
  };
}

const settings: ShipStationSettings = {
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
};

interface SwellStub {
  orders?: Record<string, any>;
  shipments?: Array<Record<string, any>>;
}

function swellStub({ orders, shipments = [] }: SwellStub) {
  const post = vi.fn(async (_url: string, body: Record<string, any>) => ({
    id: 'swell_ship_1',
    ...body,
  }));
  const put = vi.fn(async () => ({}));
  const get = vi.fn(async (url: string) => {
    if (url === '/orders/{id}') {
      return orders ?? null;
    }
    if (url === '/shipments') {
      return { results: shipments };
    }
    return null;
  });
  return { get, post, put };
}

describe('buildShipmentItems', () => {
  it('matches shipment lines to order items by lineItemKey', () => {
    const items = buildShipmentItems(context(order()), shipStationShipment() as ShipStationShipment);

    expect(items).toEqual([
      { order_item_id: 'item_1', product_id: 'prod_1', quantity: 2 },
    ]);
  });

  it('falls back to a SKU match when lineItemKey is unknown', () => {
    const items = buildShipmentItems(
      context(order()),
      shipStationShipment({
        shipmentItems: [{ lineItemKey: 'stale_id', sku: 'widget-blue', quantity: 1 }],
      }) as ShipStationShipment,
    );

    expect(items).toEqual([{ order_item_id: 'item_1', product_id: 'prod_1', quantity: 1 }]);
  });

  it('caps the quantity at what is still awaiting fulfillment', () => {
    const partlyShipped = order({
      items: [orderItem({ quantity_total: 2, quantity_delivered: 1, quantity_deliverable: 1 })],
    });

    const items = buildShipmentItems(
      context(partlyShipped),
      shipStationShipment({
        shipmentItems: [{ lineItemKey: 'item_1', quantity: 2 }],
      }) as ShipStationShipment,
    );

    expect(items[0].quantity).toBe(1);
  });

  it('does not exceed the outstanding quantity when two lines hit the same item', () => {
    const items = buildShipmentItems(
      context(order()),
      shipStationShipment({
        shipmentItems: [
          { lineItemKey: 'item_1', quantity: 2 },
          { lineItemKey: 'item_1', quantity: 2 },
        ],
      }) as ShipStationShipment,
    );

    expect(items.reduce((total, item) => total + item.quantity, 0)).toBe(2);
  });

  it('ships everything outstanding when the notification carries no item detail', () => {
    const twoLines = order({
      items: [
        orderItem({ id: 'item_1', quantity_deliverable: 2 }),
        orderItem({ id: 'item_2', product_id: 'prod_2', quantity_deliverable: 3 }),
      ],
    });

    const items = buildShipmentItems(
      context(twoLines),
      shipStationShipment({ shipmentItems: null }) as ShipStationShipment,
    );

    expect(items).toEqual([
      { order_item_id: 'item_1', product_id: 'prod_1', quantity: 2 },
      { order_item_id: 'item_2', product_id: 'prod_2', quantity: 3 },
    ]);
  });

  it('drops lines that match nothing on the order', () => {
    const items = buildShipmentItems(
      context(order()),
      shipStationShipment({
        shipmentItems: [{ lineItemKey: 'nope', sku: 'NOT-OURS', quantity: 1 }],
      }) as ShipStationShipment,
    );

    expect(items).toEqual([]);
  });

  it('includes the variant id when the line item has one', () => {
    const withVariant = order({
      items: [orderItem({ variant_id: 'var_1', variant: { id: 'var_1', sku: 'V-1' } })],
    });

    const items = buildShipmentItems(
      context(withVariant),
      shipStationShipment() as ShipStationShipment,
    );

    expect(items[0].variant_id).toBe('var_1');
  });
});

describe('carrier and service names', () => {
  it('uses known carrier names and humanises the rest', () => {
    expect(carrierName('ups')).toBe('UPS');
    expect(carrierName('stamps_com')).toBe('USPS');
    expect(carrierName('some_local_courier')).toBe('Some Local Courier');
  });

  it('builds a readable service name from the carrier prefix', () => {
    expect(serviceName('ups_ground')).toBe('UPS Ground');
    expect(serviceName('fedex_2day')).toBe('FedEx 2Day');
    expect(serviceName('priority_mail')).toBe('Priority Mail');
  });
});

describe('ingestShipments', () => {
  it('creates a Swell shipment with tracking and item quantities', async () => {
    const swell = swellStub({ orders: order() });
    const req = createMockRequest({ swell });

    const summary = await ingestShipments(req, settings, [
      shipStationShipment() as ShipStationShipment,
    ]);

    expect(summary).toMatchObject({ created: 1, duplicates: 0, failed: 0 });
    expect(swell.post).toHaveBeenCalledTimes(1);

    const [url, body] = swell.post.mock.calls[0];
    expect(url).toBe('/shipments');
    expect(body).toMatchObject({
      order_id: '6650f1a2b3c4d5e6f7a8b9c0',
      tracking_code: '1Z999AA10123456784',
      carrier_name: 'UPS',
      service_name: 'UPS Ground',
      items: [{ order_item_id: 'item_1', product_id: 'prod_1', quantity: 2 }],
    });
    expect(body.destination).toMatchObject({
      name: 'Ada Lovelace',
      address1: '221 Baker St',
      zip: '94510',
      country: 'US',
    });
    expect(body.$app.shipstation.shipment_id).toBe(900001);
  });

  it('skips a shipment that Swell already recorded', async () => {
    const swell = swellStub({
      orders: order(),
      shipments: [{ id: 'existing', $app: { shipstation: { shipment_id: 900001 } } }],
    });
    const req = createMockRequest({ swell });

    const summary = await ingestShipments(req, settings, [
      shipStationShipment() as ShipStationShipment,
    ]);

    expect(summary).toMatchObject({ created: 0, duplicates: 1 });
    expect(swell.post).not.toHaveBeenCalled();
  });

  it('cancels the Swell shipment when ShipStation voids the label', async () => {
    const swell = swellStub({
      orders: order(),
      shipments: [
        { id: 'existing', canceled: false, $app: { shipstation: { shipment_id: 900001 } } },
      ],
    });
    const req = createMockRequest({ swell });

    const summary = await ingestShipments(req, settings, [
      shipStationShipment({ voided: true }) as ShipStationShipment,
    ]);

    expect(summary).toMatchObject({ canceled: 1, created: 0 });
    expect(swell.put).toHaveBeenCalledWith(
      '/shipments/existing',
      expect.objectContaining({ canceled: true }),
    );
  });

  it('reports a shipment whose order cannot be found instead of failing the delivery', async () => {
    const swell = swellStub({ orders: undefined });
    const req = createMockRequest({ swell });

    const summary = await ingestShipments(req, settings, [
      shipStationShipment() as ShipStationShipment,
    ]);

    expect(summary.failed).toBe(1);
    expect(summary.details[0]).toMatchObject({ action: 'no_order' });
    expect(swell.post).not.toHaveBeenCalled();
  });

  it('records two partial shipments against different line items', async () => {
    const twoLines = order({
      items: [
        orderItem({ id: 'item_1', quantity_deliverable: 1 }),
        orderItem({ id: 'item_2', product_id: 'prod_2', quantity_deliverable: 1 }),
      ],
    });
    const swell = swellStub({ orders: twoLines });
    const req = createMockRequest({ swell });

    const summary = await ingestShipments(req, settings, [
      shipStationShipment({
        shipmentId: 1,
        shipmentItems: [{ lineItemKey: 'item_1', quantity: 1 }],
      }) as ShipStationShipment,
      shipStationShipment({
        shipmentId: 2,
        shipmentItems: [{ lineItemKey: 'item_2', quantity: 1 }],
      }) as ShipStationShipment,
    ]);

    expect(summary.created).toBe(2);
    expect(swell.post.mock.calls[0][1].items).toEqual([
      { order_item_id: 'item_1', product_id: 'prod_1', quantity: 1 },
    ]);
    expect(swell.post.mock.calls[1][1].items).toEqual([
      { order_item_id: 'item_2', product_id: 'prod_2', quantity: 1 },
    ]);
    // The order is fetched once and reused for both shipments in the same delivery.
    expect(swell.get.mock.calls.filter(([url]) => url === '/shipments')).toHaveLength(1);
  });
});
