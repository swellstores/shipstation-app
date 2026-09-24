import { describe, expect, it } from 'vitest';
import { mapOrder, shippableItems } from '../../functions/lib/order-mapper';
import { createSwellClient } from '../helpers/swell-client';

const SHIPSTATION_STATUSES = [
  'awaiting_payment',
  'awaiting_shipment',
  'shipped',
  'on_hold',
  'cancelled',
  'pending_fulfillment',
];

/**
 * Guards the mapper against drift in the real order shape — expansions, field names and
 * quantity semantics — without needing ShipStation credentials.
 */
describe('order mapping against live store data', () => {
  it('turns a real order into a payload ShipStation would accept', async () => {
    const swell = createSwellClient();

    const response = await swell.get('/orders', {
      limit: 10,
      sort: 'date_created desc',
      expand: ['account', 'items.product', 'items.variant'],
    });

    const candidates: Array<Record<string, any>> = response?.results ?? [];
    const order = candidates.find(
      (record) => shippableItems(record).length > 0 && (record.shipping || record.billing),
    );

    if (!order) {
      console.warn(
        `Skipping: none of the ${candidates.length} most recent orders have a shippable item and an address.`,
      );
      return;
    }

    const payload = mapOrder(order, { orderPrefix: 'TEST-', weightUnit: 'lb' });

    expect(payload.orderKey).toBe(order.id);
    expect(payload.orderNumber).toBe(`TEST-${order.number}`);
    expect(SHIPSTATION_STATUSES).toContain(payload.orderStatus);
    expect(payload.orderDate).toBeTruthy();

    for (const address of [payload.shipTo, payload.billTo]) {
      expect(address.name).toBeTruthy();
      expect(address.country).toBeTruthy();
    }

    expect(payload.items.length).toBe(shippableItems(order).length);
    for (const item of payload.items) {
      expect(item.lineItemKey).toBeTruthy();
      expect(item.name).toBeTruthy();
      expect(item.quantity).toBeGreaterThan(0);
    }
  });

  it('reads the weight unit the mapper depends on from shipment settings', async () => {
    const swell = createSwellClient();

    const shipmentSettings = await swell.get('/settings/shipments');

    expect(shipmentSettings).toBeDefined();
    expect(['lb', 'oz', 'g', 'kg']).toContain(shipmentSettings.weight_unit);
  });

  it('exposes the app settings record once the app is deployed', async () => {
    const swell = createSwellClient();

    // Values are null until a merchant fills them in; this only proves the record exists.
    const settings = await swell.get('/settings/shipstation');

    expect(settings).toBeDefined();
  });
});
