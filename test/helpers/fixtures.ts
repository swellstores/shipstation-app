/** Shapes mirror what /orders returns with items.product and items.variant expanded. */

export interface FixtureOptions {
  paid?: boolean;
  canceled?: boolean;
  hold?: boolean;
  shipping?: Record<string, any> | null;
  billing?: Record<string, any> | null;
  items?: Array<Record<string, any>>;
}

export function orderItem(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: 'item_1',
    delivery: 'shipment',
    product_id: 'prod_1',
    variant_id: null,
    product_name: 'Blue Widget',
    variant_name: null,
    quantity: 2,
    quantity_total: 2,
    quantity_deliverable: 2,
    quantity_delivered: 0,
    price: 25,
    shipment_weight: 1.5,
    product: { id: 'prod_1', name: 'Blue Widget', sku: 'WIDGET-BLUE' },
    variant: null,
    ...overrides,
  };
}

export function order(options: FixtureOptions = {}): Record<string, any> {
  const {
    paid = true,
    canceled = false,
    hold = false,
    shipping = {
      name: 'Ada Lovelace',
      address1: '221 Baker St',
      address2: 'Apt 2',
      city: 'Benicia',
      state: 'CA',
      zip: '94510',
      country: 'US',
      phone: '+15550100',
      service_name: 'Standard',
    },
    billing = {
      name: 'Ada Lovelace',
      address1: '1 Billing Way',
      city: 'Benicia',
      state: 'CA',
      zip: '94510',
      country: 'US',
    },
    items = [orderItem()],
  } = options;

  return {
    id: '6650f1a2b3c4d5e6f7a8b9c0',
    number: 'BVR100042',
    date_created: '2026-07-01T10:00:00.000Z',
    paid,
    canceled,
    hold,
    payment_total: 50,
    tax_total: 4,
    shipment_total: 7.5,
    sub_total: 50,
    notes: 'Leave at the door',
    gift: false,
    shipping,
    billing,
    items,
    account: { email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace' },
  };
}

export function shipStationShipment(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    shipmentId: 900001,
    orderId: 500001,
    orderKey: '6650f1a2b3c4d5e6f7a8b9c0',
    orderNumber: 'BVR100042',
    shipDate: '2026-07-02',
    trackingNumber: '1Z999AA10123456784',
    carrierCode: 'ups',
    serviceCode: 'ups_ground',
    batchNumber: 'B-1',
    voided: false,
    shipTo: {
      name: 'Ada Lovelace',
      street1: '221 Baker St',
      street2: 'Apt 2',
      city: 'Benicia',
      state: 'CA',
      postalCode: '94510',
      country: 'US',
      phone: '+15550100',
    },
    shipmentItems: [{ lineItemKey: 'item_1', sku: 'WIDGET-BLUE', name: 'Blue Widget', quantity: 2 }],
    ...overrides,
  };
}
