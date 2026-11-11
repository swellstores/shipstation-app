import { afterEach, describe, expect, it, vi } from 'vitest';
import testConnection from '../../functions/test-connection';
import { createMockRequest } from '../helpers/mock-request';

const STORES = [
  { storeId: 101, storeName: 'Manual Orders', active: true },
  { storeId: 202, storeName: 'Swell', active: true },
];

function request(settings: Record<string, unknown>, response: Response) {
  vi.stubGlobal('fetch', vi.fn(async () => response));
  return createMockRequest({
    swell: { settings: vi.fn(async () => ({ shipstation: settings })) },
  });
}

const CREDENTIALS = { api_key: 'key', api_secret: 'secret' };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('test-connection action', () => {
  it('lists the stores it reached and registers nothing', async () => {
    const req = request(CREDENTIALS, new Response(JSON.stringify(STORES), { status: 200 }));

    await expect(testConnection(req)).resolves.toEqual({
      message: 'Connected to ShipStation. Stores in this account: Manual Orders, Swell.',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((fetch as any).mock.calls[0][0]).toBe('https://ssapi.shipstation.com/stores');
  });

  it('names the configured store', async () => {
    const req = request(
      { ...CREDENTIALS, store_id: '202' },
      new Response(JSON.stringify(STORES), { status: 200 }),
    );

    await expect(testConnection(req)).resolves.toEqual({
      message: 'Connected to ShipStation store Swell.',
    });
  });

  it('fails when the store ID is not in the account', async () => {
    const req = request(
      { ...CREDENTIALS, store_id: '999' },
      new Response(JSON.stringify(STORES), { status: 200 }),
    );

    await expect(testConnection(req)).rejects.toThrow(/no store with the ID 999/);
  });

  it('says the credentials were rejected on a 401', async () => {
    // what ShipStation actually sends for a wrong key: a plain-text body
    const req = request(CREDENTIALS, new Response('401 Unauthorized', { status: 401 }));

    await expect(testConnection(req)).rejects.toThrow(/didn't accept the API key and secret/);
  });

  it('asks for the missing credentials before calling ShipStation', async () => {
    const req = request({ api_key: 'key' }, new Response('[]'));

    await expect(testConnection(req)).rejects.toThrow('Add the API secret and save the settings first.');
    expect(fetch).not.toHaveBeenCalled();
  });
});
