import { describe, expect, it } from 'vitest';
import {
  mapOrder,
  shippableItems,
  stripOrderPrefix,
  toShipStationWeight,
} from '../../functions/lib/order-mapper';
import { order, orderItem } from '../helpers/fixtures';

describe('mapOrder', () => {
  it('uses the Swell order id as orderKey so repeated pushes upsert', () => {
    const payload = mapOrder(order());

    expect(payload.orderKey).toBe('6650f1a2b3c4d5e6f7a8b9c0');
    expect(payload.orderNumber).toBe('BVR100042');
    expect(payload.advancedOptions?.customField1).toBe('swell:6650f1a2b3c4d5e6f7a8b9c0');
  });

  it('prefixes the order number when configured', () => {
    const payload = mapOrder(order(), { orderPrefix: 'SW-' });

    expect(payload.orderNumber).toBe('SW-BVR100042');
  });

  it('marks paid orders awaiting shipment and unpaid orders awaiting payment', () => {
    expect(mapOrder(order({ paid: true })).orderStatus).toBe('awaiting_shipment');
    expect(mapOrder(order({ paid: false })).orderStatus).toBe('awaiting_payment');
  });

  it('reports held and canceled orders with their own status', () => {
    expect(mapOrder(order({ hold: true })).orderStatus).toBe('on_hold');
    expect(mapOrder(order({ canceled: true })).orderStatus).toBe('cancelled');
  });

  it('lets the caller force a status for the cancellation path', () => {
    const payload = mapOrder(order({ paid: true }), { status: 'cancelled' });

    expect(payload.orderStatus).toBe('cancelled');
  });

  it('maps addresses onto ShipStation field names', () => {
    const payload = mapOrder(order());

    expect(payload.shipTo).toMatchObject({
      name: 'Ada Lovelace',
      street1: '221 Baker St',
      street2: 'Apt 2',
      postalCode: '94510',
      country: 'US',
    });
    expect(payload.billTo.street1).toBe('1 Billing Way');
  });

  it('falls back to the billing address when there is no shipping address', () => {
    const payload = mapOrder(order({ shipping: null }));

    expect(payload.shipTo.street1).toBe('1 Billing Way');
    expect(payload.billTo.street1).toBe('1 Billing Way');
  });

  it('falls back to the shipping address when there is no billing address', () => {
    const payload = mapOrder(order({ billing: null }));

    expect(payload.billTo.street1).toBe('221 Baker St');
  });

  it('refuses to map an order with no address at all', () => {
    expect(() => mapOrder(order({ shipping: null, billing: null }))).toThrow(
      /no shipping or billing address/,
    );
  });

  it('carries the order item id as lineItemKey so shipments can be matched back', () => {
    const payload = mapOrder(order());

    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toMatchObject({
      lineItemKey: 'item_1',
      sku: 'WIDGET-BLUE',
      name: 'Blue Widget',
      quantity: 2,
      unitPrice: 25,
    });
  });

  it('sends the price the customer paid per unit, as the native integration does', () => {
    // price + tax_each - discount_each (swell-admin lib/shipstation.js). ShipStation uses
    // it for customs values and packing slips.
    const payload = mapOrder(
      order({
        items: [orderItem({ price: 19.99, tax_each: 1.6, discount_each: 2, tax_total: 3.2 })],
      }),
    );

    expect(payload.items[0].unitPrice).toBe(19.59);
    expect(payload.items[0].taxAmount).toBe(3.2);
  });

  it('sends product options, dropping any without a value', () => {
    const payload = mapOrder(
      order({
        items: [
          orderItem({
            options: [
              { name: 'Size', value: 'Large' },
              { name: 'Engraving', value: '' },
              { name: 'Gift wrap', value: null },
              { name: 'Count', value: 3 },
            ],
          }),
        ],
      }),
    );

    expect(payload.items[0].options).toEqual([
      { name: 'Size', value: 'Large' },
      { name: 'Count', value: '3' },
    ]);
  });

  it('leaves options off an item that has none', () => {
    expect(mapOrder(order()).items[0].options).toBeUndefined();
  });

  it('appends the variant name and prefers the variant SKU', () => {
    const payload = mapOrder(
      order({
        items: [
          orderItem({
            variant_id: 'var_1',
            variant_name: 'Large',
            variant: { id: 'var_1', name: 'Large', sku: 'WIDGET-BLUE-L' },
          }),
        ],
      }),
    );

    expect(payload.items[0].name).toBe('Blue Widget - Large');
    expect(payload.items[0].sku).toBe('WIDGET-BLUE-L');
  });

  it('excludes giftcard and subscription items and fully canceled lines', () => {
    const payload = mapOrder(
      order({
        items: [
          orderItem({ id: 'a' }),
          orderItem({ id: 'b', delivery: 'giftcard' }),
          orderItem({ id: 'c', delivery: 'subscription' }),
          orderItem({ id: 'd', quantity_total: 0 }),
        ],
      }),
    );

    expect(payload.items.map((item) => item.lineItemKey)).toEqual(['a']);
  });

  it('omits storeId when the setting is blank rather than sending 0', () => {
    expect(mapOrder(order(), { storeId: '' }).advancedOptions?.storeId).toBeUndefined();
    expect(mapOrder(order(), { storeId: '12345' }).advancedOptions?.storeId).toBe(12345);
  });

  it('passes through totals, email and the requested service', () => {
    const payload = mapOrder(order());

    expect(payload.amountPaid).toBe(50);
    expect(payload.taxAmount).toBe(4);
    expect(payload.shippingAmount).toBe(7.5);
    expect(payload.customerEmail).toBe('ada@example.com');
    expect(payload.requestedShippingService).toBe('Standard');
    expect(payload.internalNotes).toBe('Leave at the door');
  });
});

describe('toShipStationWeight', () => {
  it('maps store weight units onto the three ShipStation units', () => {
    expect(toShipStationWeight(2, 'lb')).toEqual({ value: 2, units: 'pounds' });
    expect(toShipStationWeight(8, 'oz')).toEqual({ value: 8, units: 'ounces' });
    expect(toShipStationWeight(500, 'g')).toEqual({ value: 500, units: 'grams' });
  });

  it('converts kilograms to grams because ShipStation has no kilogram unit', () => {
    expect(toShipStationWeight(1.2, 'kg')).toEqual({ value: 1200, units: 'grams' });
  });

  it('ignores missing or zero weights', () => {
    expect(toShipStationWeight(0, 'lb')).toBeUndefined();
    expect(toShipStationWeight(null, 'lb')).toBeUndefined();
    expect(toShipStationWeight(undefined, 'lb')).toBeUndefined();
  });
});

describe('stripOrderPrefix', () => {
  it('removes the configured prefix and leaves other numbers alone', () => {
    expect(stripOrderPrefix('SW-BVR100042', 'SW-')).toBe('BVR100042');
    expect(stripOrderPrefix('BVR100042', 'SW-')).toBe('BVR100042');
    expect(stripOrderPrefix('BVR100042', '')).toBe('BVR100042');
  });
});

describe('shippableItems', () => {
  it('tolerates an order with no items array', () => {
    expect(shippableItems({})).toEqual([]);
  });
});
