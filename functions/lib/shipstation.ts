const API_BASE = 'https://ssapi.shipstation.com';

export const API_HOST = 'ssapi.shipstation.com';

/**
 * Hosts a webhook `resource_url` may point at. ShipStation hands out numbered API hosts
 * (`ssapi12.shipstation.com`) as well as the bare one; the native integration matches
 * `ssapi\d*` for the same reason (swell-admin `server/api/integration/shipstation.js:132`).
 * Accepting only the bare host rejected every real delivery.
 */
export const RESOURCE_HOST = /^ssapi\d*\.shipstation\.com$/;

// ShipStation allows ~40 requests/minute. When it pushes back briefly we wait inline;
// anything longer is reported as retryable so the platform can redeliver the event
// instead of burning the function's 10s budget.
const MAX_INLINE_WAIT_MS = 2000;

/**
 * ShipStation can be slow — a rejected credential takes about six seconds to come back.
 * Bounding each call leaves enough of the function's 10s budget to record the failure on
 * the order, which is the difference between a visible error and a silent timeout. The
 * update and cancel paths make two calls in one invocation, so the two budgets below have
 * to add up to well under the limit.
 */
const DEFAULT_TIMEOUT_MS = 4000;

/** Tighter budget for the pre-update status probe, which is only advisory. */
export const PROBE_TIMEOUT_MS = 2000;

export type ShipStationOrderStatus =
  | 'awaiting_payment'
  | 'awaiting_shipment'
  | 'shipped'
  | 'on_hold'
  | 'cancelled'
  | 'pending_fulfillment';

export interface ShipStationAddress {
  name?: string | null;
  company?: string | null;
  street1?: string | null;
  street2?: string | null;
  street3?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  phone?: string | null;
  residential?: boolean | null;
}

export interface ShipStationWeight {
  value: number;
  units: 'pounds' | 'ounces' | 'grams';
}

export interface ShipStationOrderItem {
  lineItemKey?: string;
  sku?: string;
  name?: string;
  quantity: number;
  unitPrice?: number;
  taxAmount?: number;
  weight?: ShipStationWeight;
  options?: Array<{ name: string; value: string }>;
}

export interface ShipStationOrder {
  orderNumber: string;
  orderKey: string;
  orderDate: string;
  orderStatus: ShipStationOrderStatus;
  customerEmail?: string;
  customerUsername?: string;
  billTo: ShipStationAddress;
  shipTo: ShipStationAddress;
  items: ShipStationOrderItem[];
  amountPaid?: number;
  taxAmount?: number;
  shippingAmount?: number;
  internalNotes?: string;
  gift?: boolean;
  giftMessage?: string;
  requestedShippingService?: string;
  advancedOptions?: Record<string, unknown>;
}

export interface ShipStationOrderResponse {
  orderId?: number;
  orderKey?: string;
  orderNumber?: string;
  orderStatus?: ShipStationOrderStatus;
}

export interface ShipStationShipmentItem {
  lineItemKey?: string | null;
  orderItemId?: number | null;
  sku?: string | null;
  name?: string | null;
  quantity?: number | null;
}

export interface ShipStationShipment {
  shipmentId?: number | null;
  orderId?: number | null;
  orderKey?: string | null;
  orderNumber?: string | null;
  shipDate?: string | null;
  trackingNumber?: string | null;
  carrierCode?: string | null;
  serviceCode?: string | null;
  batchNumber?: string | null;
  voided?: boolean | null;
  shipTo?: ShipStationAddress | null;
  shipmentItems?: ShipStationShipmentItem[] | null;
}

/** ShipStation returns webhook records with PascalCase keys; readers below tolerate both. */
export interface ShipStationWebhookRecord {
  [key: string]: unknown;
}

export type WebhookEvent =
  | 'ORDER_NOTIFY'
  | 'ITEM_ORDER_NOTIFY'
  | 'SHIP_NOTIFY'
  | 'ITEM_SHIP_NOTIFY'
  | 'FULFILLMENT_SHIPPED'
  | 'FULFILLMENT_REJECTED';

export class ShipStationError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly body: unknown;

  constructor(
    message: string,
    options: { status?: number; retryable?: boolean; body?: unknown } = {},
  ) {
    super(message);
    this.name = 'ShipStationError';
    this.status = options.status ?? 0;
    this.retryable = options.retryable ?? false;
    this.body = options.body;
  }
}

export function errorText(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return typeof err === 'string' ? err : JSON.stringify(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBody(text: string): unknown {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function retryAfterMs(res: Response): number | null {
  const header = res.headers.get('Retry-After') ?? res.headers.get('X-Rate-Limit-Reset');
  if (!header) {
    return null;
  }
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

function describeError(status: number, parsed: unknown, raw: string): string {
  const record = (parsed ?? {}) as Record<string, unknown>;
  const message =
    (typeof record.ExceptionMessage === 'string' && record.ExceptionMessage) ||
    (typeof record.Message === 'string' && record.Message) ||
    (typeof record.message === 'string' && record.message) ||
    raw.slice(0, 300) ||
    'no response body';
  return `ShipStation returned ${status}: ${message}`;
}

interface SendOptions {
  body?: unknown;
  timeoutMs?: number;
  alreadyWaited?: boolean;
}

export class ShipStationClient {
  private readonly auth: string;
  private readonly timeoutMs: number;

  constructor(apiKey: string, apiSecret: string, options: { timeoutMs?: number } = {}) {
    this.auth = `Basic ${btoa(`${apiKey}:${apiSecret}`)}`;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async send<T>(method: string, url: string, options: SendOptions = {}): Promise<T> {
    const { body, alreadyWaited = false } = options;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: this.auth,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new ShipStationError(
        timedOut
          ? `ShipStation did not respond within ${timeoutMs}ms`
          : `Could not reach ShipStation: ${errorText(err)}`,
        { retryable: true },
      );
    }

    if (res.status === 429 && !alreadyWaited) {
      const wait = retryAfterMs(res);
      if (wait !== null && wait <= MAX_INLINE_WAIT_MS) {
        await sleep(wait);
        return this.send<T>(method, url, { ...options, alreadyWaited: true });
      }
    }

    const raw = await res.text();
    const parsed = parseBody(raw);

    if (!res.ok) {
      throw new ShipStationError(describeError(res.status, parsed, raw), {
        status: res.status,
        retryable: res.status === 429 || res.status >= 500,
        body: parsed ?? raw,
      });
    }

    return (parsed ?? {}) as T;
  }

  private request<T>(method: string, path: string, options: SendOptions = {}): Promise<T> {
    return this.send<T>(method, `${API_BASE}${path}`, options);
  }

  /** Creates the order, or replaces it wholesale when `orderKey` already exists. */
  createOrder(order: ShipStationOrder): Promise<ShipStationOrderResponse> {
    return this.request<ShipStationOrderResponse>('POST', '/orders/createorder', { body: order });
  }

  getOrder(orderId: number, timeoutMs?: number): Promise<ShipStationOrderResponse | null> {
    return this.request<ShipStationOrderResponse | null>('GET', `/orders/${orderId}`, {
      timeoutMs,
    });
  }

  async findOrderByNumber(
    orderNumber: string,
    timeoutMs?: number,
  ): Promise<ShipStationOrderResponse | null> {
    const res = await this.request<{ orders?: ShipStationOrderResponse[] }>(
      'GET',
      `/orders?orderNumber=${encodeURIComponent(orderNumber)}`,
      { timeoutMs },
    );
    return res?.orders?.[0] ?? null;
  }

  async listStores(): Promise<Array<Record<string, unknown>>> {
    const res = await this.request<Array<Record<string, unknown>>>('GET', '/stores');
    return Array.isArray(res) ? res : [];
  }

  async listWebhooks(): Promise<ShipStationWebhookRecord[]> {
    const res = await this.request<{ webhooks?: ShipStationWebhookRecord[] }>('GET', '/webhooks');
    return res?.webhooks ?? [];
  }

  subscribeWebhook(input: {
    target_url: string;
    event: WebhookEvent;
    friendly_name?: string;
    store_id?: number;
  }): Promise<{ id?: number }> {
    return this.request<{ id?: number }>('POST', '/webhooks/subscribe', { body: input });
  }

  deleteWebhook(webhookId: number): Promise<unknown> {
    return this.request<unknown>('DELETE', `/webhooks/${webhookId}`);
  }

  /**
   * Fetches a `resource_url` handed to us by a webhook delivery.
   *
   * This fetch is also what authenticates the delivery: it goes out with the merchant's
   * API credentials, to a ShipStation host, for a shipments listing, so whatever comes back
   * is the merchant's real shipment data no matter who sent the notification. The host and
   * path checks keep a forged body from turning this public route into a request proxy.
   */
  async fetchShipments(
    resourceUrl: string,
  ): Promise<{ shipments?: ShipStationShipment[]; pages?: number }> {
    let url: URL;
    try {
      url = new URL(resourceUrl);
    } catch {
      throw new ShipStationError(`Webhook resource_url is not a valid URL: ${resourceUrl}`, {
        status: 400,
      });
    }
    if (url.protocol !== 'https:' || !RESOURCE_HOST.test(url.hostname.toLowerCase())) {
      throw new ShipStationError(
        `Refusing to fetch a webhook resource from ${url.hostname}; expected a ShipStation API host`,
        { status: 400 },
      );
    }
    if (url.pathname.replace(/\/+$/, '').toLowerCase() !== '/shipments') {
      throw new ShipStationError(
        `Refusing to fetch a webhook resource at ${url.pathname}; expected /shipments`,
        { status: 400 },
      );
    }
    // SHIP_NOTIFY resource URLs default this off, and without it there are no per-item
    // quantities to build a partial shipment from.
    url.searchParams.set('includeShipmentItems', 'True');
    return this.send<{ shipments?: ShipStationShipment[]; pages?: number }>('GET', url.toString());
  }
}

export function webhookId(record: ShipStationWebhookRecord): number | null {
  const value = record.WebHookID ?? record.webHookID ?? record.webhookId ?? record.id;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function webhookName(record: ShipStationWebhookRecord): string {
  const value = record.Name ?? record.name ?? record.friendly_name;
  return typeof value === 'string' ? value : '';
}

export function webhookUrl(record: ShipStationWebhookRecord): string {
  const value = record.Url ?? record.url ?? record.target_url;
  return typeof value === 'string' ? value : '';
}

export function webhookEvent(record: ShipStationWebhookRecord): string {
  const value = record.HookType ?? record.hookType ?? record.event;
  return typeof value === 'string' ? value : '';
}
