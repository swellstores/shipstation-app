import { PushResult, pushOrder } from './lib/push';
import { appId, getSettings } from './lib/settings';

export const config: SwellConfig = {
  description: 'Manually push orders to ShipStation',
  route: {
    methods: ['post'],
    public: false,
  },
};

/** Keeps a batch re-sync inside the function's time budget. */
const MAX_BATCH = 10;

function text(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}

async function idsForStatus(req: SwellRequest, status: string): Promise<string[]> {
  const response = (await req.swell.get('/orders', {
    [`$app.${appId(req)}.sync_status`]: status,
    limit: MAX_BATCH,
    sort: 'date_created desc',
  })) as { results?: Array<{ id: string }> } | null;
  return (response?.results ?? []).map((order) => order.id);
}

export async function post(req: SwellRequest) {
  const settings = await getSettings(req);
  if (!settings.enabled) {
    throw new SwellError('ShipStation sync is turned off in app settings.', { status: 409 });
  }

  const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<
    string,
    any
  >;
  const orderId = text(body.order_id);
  const syncStatus = text(body.sync_status);

  let orderIds: string[];
  if (orderId) {
    orderIds = [orderId];
  } else if (syncStatus) {
    orderIds = await idsForStatus(req, syncStatus);
  } else {
    throw new SwellError(
      'Provide either "order_id" to push one order, or "sync_status" (for example "error") to push a batch.',
      { status: 400 },
    );
  }

  const results: PushResult[] = [];
  for (const id of orderIds) {
    // The shipped guard still applies: ShipStation refuses edits to shipped orders, and a
    // forced push would only record a confusing error.
    results.push(await pushOrder(req, settings, id, { guardShipped: true }));
  }

  return {
    ok: results.every((result) => result.ok),
    requested: orderIds.length,
    pushed: results.filter((result) => result.action === 'pushed').length,
    results,
  };
}
