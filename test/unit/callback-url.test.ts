import { describe, expect, it, vi } from 'vitest';
import {
  WEBHOOK_FUNCTION_DESCRIPTION,
  WEBHOOK_FUNCTION_NAME,
  webhookCallbackUrl,
} from '../../functions/lib/settings';
import { createMockRequest } from '../helpers/mock-request';

const OBJECT_ID = '0123456789abcdef01234567';

function settings(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    api_key: 'key',
    api_secret: 'secret',
    store_id: '',
    push_trigger: 'paid' as const,
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

function functionRow(overrides: Record<string, unknown> = {}) {
  return {
    name: WEBHOOK_FUNCTION_NAME,
    description: WEBHOOK_FUNCTION_DESCRIPTION,
    app_id: OBJECT_ID,
    ...overrides,
  };
}

function callbackRequest(rows: Array<Record<string, unknown>> | Error) {
  return createMockRequest({
    swell: {
      get: vi.fn(async () => {
        if (rows instanceof Error) throw rows;
        return { results: rows };
      }),
    },
  });
}

describe('webhookCallbackUrl', () => {
  it("builds the URL from the app's ObjectId, the only form a public call resolves", async () => {
    // The string-id form (/functions/shipstation/…) needs a Swell API key to resolve, which
    // ShipStation never sends, so it 404s and every delivery is dropped.
    const req = callbackRequest([functionRow()]);

    const url = await webhookCallbackUrl(req, settings());

    expect(url).toBe(
      `https://${req.store.id}.swell.store/functions/${OBJECT_ID}/shipstation-webhook?secret=a-long-enough-secret`,
    );
  });

  it('returns null rather than a string-id URL when the ObjectId cannot be found', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await webhookCallbackUrl(callbackRequest([]), settings())).toBeNull();
    expect(await webhookCallbackUrl(callbackRequest(new Error('registry down')), settings())).toBeNull();
    // Another app's function with the same name is not ours.
    expect(
      await webhookCallbackUrl(callbackRequest([functionRow({ description: 'other' })]), settings()),
    ).toBeNull();
    // Two matches are ambiguous.
    expect(
      await webhookCallbackUrl(callbackRequest([functionRow(), functionRow({ app_id: 'f'.repeat(24) })]), settings()),
    ).toBeNull();
  });

  it('uses the callback_url override without a registry lookup', async () => {
    const req = callbackRequest([]);
    const url = await webhookCallbackUrl(
      req,
      settings({ callback_url: 'https://tunnel.example/hook' }),
    );
    expect(url).toBe('https://tunnel.example/hook?secret=a-long-enough-secret');
    expect(req.swell.get).not.toHaveBeenCalled();
  });
});

describe("the webhook route's declared description", () => {
  it('matches WEBHOOK_FUNCTION_DESCRIPTION, which ObjectId discovery matches on', async () => {
    const route: any = await import('../../functions/shipstation-webhook');
    expect(route.config.description).toBe(WEBHOOK_FUNCTION_DESCRIPTION);
  });
});
