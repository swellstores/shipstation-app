import {
  ShipStationAddress,
  ShipStationError,
  ShipStationOrder,
  ShipStationOrderItem,
  ShipStationOrderStatus,
  ShipStationWeight,
} from './shipstation';

export interface MapOrderOptions {
  orderPrefix?: string;
  storeId?: string;
  /** `weight_unit` from /settings/shipments (lb, oz, g, kg). */
  weightUnit?: string;
  /** Forces an order status, used by the cancellation path. */
  status?: ShipStationOrderStatus;
}

function joinName(first: unknown, last: unknown): string {
  return [first, last]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(' ');
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

// Empty strings and null must not slip through as 0 — an empty store_id setting would
// otherwise be sent to ShipStation as storeId 0.
function num(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function int(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function toAddress(source: unknown, fallbackName?: string): ShipStationAddress | null {
  if (!source || typeof source !== 'object') {
    return null;
  }
  const src = source as Record<string, unknown>;
  const name = str(src.name) ?? joinName(src.first_name, src.last_name) ?? fallbackName;
  const street1 = str(src.address1);
  if (!name && !street1) {
    return null;
  }
  return {
    name: name || 'Customer',
    street1: street1 ?? null,
    street2: str(src.address2) ?? null,
    city: str(src.city) ?? null,
    state: str(src.state) ?? null,
    postalCode: str(src.zip) ?? null,
    country: str(src.country) ?? null,
    phone: str(src.phone) ?? null,
  };
}

/**
 * ShipStation only understands pounds, ounces and grams. Kilograms are converted rather
 * than rejected so stores on metric weights still get usable rate estimates.
 */
export function toShipStationWeight(
  value: unknown,
  unit: string | undefined,
): ShipStationWeight | undefined {
  const weight = num(value);
  if (weight === undefined || weight <= 0) {
    return undefined;
  }
  switch ((unit ?? 'lb').toLowerCase()) {
    case 'oz':
    case 'ounce':
    case 'ounces':
      return { value: weight, units: 'ounces' };
    case 'g':
    case 'gram':
    case 'grams':
      return { value: weight, units: 'grams' };
    case 'kg':
    case 'kilogram':
    case 'kilograms':
      return { value: weight * 1000, units: 'grams' };
    default:
      return { value: weight, units: 'pounds' };
  }
}

function resolveStatus(
  order: Record<string, any>,
  override?: ShipStationOrderStatus,
): ShipStationOrderStatus {
  if (override) {
    return override;
  }
  if (order.canceled) {
    return 'cancelled';
  }
  if (order.hold) {
    return 'on_hold';
  }
  return order.paid ? 'awaiting_shipment' : 'awaiting_payment';
}

/** Line items ShipStation should see: physical goods that were not fully canceled. */
export function shippableItems(order: Record<string, any>): Array<Record<string, any>> {
  const items = Array.isArray(order.items) ? order.items : [];
  return items.filter((item) => item?.delivery === 'shipment' && int(item.quantity_total) > 0);
}

function mapItem(item: Record<string, any>, weightUnit?: string): ShipStationOrderItem {
  const productName = str(item.product_name) ?? str(item.product?.name) ?? 'Item';
  const variantName = str(item.variant_name) ?? str(item.variant?.name);

  const mapped: ShipStationOrderItem = {
    // The Swell order item id round-trips back on SHIP_NOTIFY, which is what lets a
    // partial shipment be matched to the right line items.
    lineItemKey: String(item.id),
    name: variantName ? `${productName} - ${variantName}` : productName,
    quantity: int(item.quantity_total),
  };

  const sku = str(item.variant?.sku) ?? str(item.product?.sku);
  if (sku) {
    mapped.sku = sku;
  }
  // What the customer actually paid per unit, as the native integration sends it
  // (swell-admin `lib/shipstation.js`): list price plus per-unit tax, less per-unit discount.
  // ShipStation uses it for customs declarations and packing slips.
  const price = num(item.price);
  if (price !== undefined) {
    mapped.unitPrice = roundMoney(price + (num(item.tax_each) ?? 0) - (num(item.discount_each) ?? 0));
  }
  const taxAmount = num(item.tax_total);
  if (taxAmount !== undefined) {
    mapped.taxAmount = taxAmount;
  }
  const weight = toShipStationWeight(item.shipment_weight, weightUnit);
  if (weight) {
    mapped.weight = weight;
  }
  const options = itemOptions(item);
  if (options.length > 0) {
    mapped.options = options;
  }
  return mapped;
}

/** Floating-point sums of currency values leave tails like 19.990000000000002. */
function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Product options (size, colour, engraving text…) so pickers see them on the order and
 * the packing slip. ShipStation rejects an option with an empty value, so those are
 * dropped, as the native integration does.
 */
function itemOptions(item: Record<string, any>): Array<{ name: string; value: string }> {
  const options = Array.isArray(item.options) ? item.options : [];
  const mapped: Array<{ name: string; value: string }> = [];
  for (const option of options) {
    const name = str(option?.name);
    const value = option?.value;
    const text = typeof value === 'string' ? value.trim() : value == null ? '' : String(value);
    if (name && text) {
      mapped.push({ name, value: text });
    }
  }
  return mapped;
}

/**
 * Builds the `/orders/createorder` payload. `orderKey` is the Swell order id, which makes
 * every push an idempotent upsert of the same ShipStation order.
 */
export function mapOrder(
  order: Record<string, any>,
  options: MapOrderOptions = {},
): ShipStationOrder {
  const customerName = joinName(order.account?.first_name, order.account?.last_name);
  const shipTo = toAddress(order.shipping, customerName) ?? toAddress(order.billing, customerName);
  const billTo = toAddress(order.billing, customerName) ?? shipTo;

  if (!shipTo || !billTo) {
    throw new ShipStationError(
      `Order ${order.number ?? order.id} has no shipping or billing address, so it cannot be sent to ShipStation.`,
      { status: 422 },
    );
  }

  const payload: ShipStationOrder = {
    orderNumber: `${options.orderPrefix ?? ''}${order.number ?? order.id}`,
    orderKey: String(order.id),
    orderDate: str(order.date_created) ?? new Date().toISOString(),
    orderStatus: resolveStatus(order, options.status),
    billTo,
    shipTo,
    items: shippableItems(order).map((item) => mapItem(item, options.weightUnit)),
    advancedOptions: {
      source: 'Swell',
      // Visible and searchable in the ShipStation UI, unlike orderKey.
      customField1: `swell:${order.id}`,
    },
  };

  const email = str(order.account?.email);
  if (email) {
    payload.customerEmail = email;
    payload.customerUsername = email;
  }

  const amountPaid = num(order.payment_total);
  if (amountPaid !== undefined) {
    payload.amountPaid = amountPaid;
  }
  const taxAmount = num(order.tax_total);
  if (taxAmount !== undefined) {
    payload.taxAmount = taxAmount;
  }
  const shippingAmount = num(order.shipment_total);
  if (shippingAmount !== undefined) {
    payload.shippingAmount = shippingAmount;
  }
  const notes = str(order.notes);
  if (notes) {
    payload.internalNotes = notes;
  }
  if (order.gift) {
    payload.gift = true;
    const giftMessage = str(order.gift_message);
    if (giftMessage) {
      payload.giftMessage = giftMessage;
    }
  }
  const requestedService = str(order.shipping?.service_name);
  if (requestedService) {
    payload.requestedShippingService = requestedService;
  }
  const storeId = num(options.storeId);
  if (storeId !== undefined) {
    payload.advancedOptions!.storeId = storeId;
  }

  return payload;
}

/** Reverses the configured prefix so a ShipStation order number maps back to a Swell one. */
export function stripOrderPrefix(orderNumber: string, prefix: string): string {
  if (prefix && orderNumber.startsWith(prefix)) {
    return orderNumber.slice(prefix.length);
  }
  return orderNumber;
}
