import { ShipStationClient, ShipStationError, errorText } from './lib/shipstation';
import { getSettings } from './lib/settings';

export const config: SwellConfig = {
  description: 'Check the ShipStation API key and secret',
  action: true,
};

// ShipStation takes about 5 seconds to reject bad credentials, longer than the client's
// default budget, so a wrong key would otherwise read as a timeout.
const TIMEOUT_MS = 8000;

// a thrown 400 shows in the admin as a red error popup, a returned message as a regular one
function fail(message: string): never {
  throw new SwellError(message, { status: 400 });
}

export default async function (req: SwellRequest) {
  const settings = await getSettings(req);

  const missing = [!settings.api_key && 'API key', !settings.api_secret && 'API secret'].filter(Boolean);
  if (missing.length) {
    fail(`Add the ${missing.join(' and ')} and save the settings first.`);
  }

  // read-only: lists the account's stores, registers nothing
  let stores: Array<Record<string, unknown>>;
  try {
    stores = await new ShipStationClient(settings.api_key, settings.api_secret, {
      timeoutMs: TIMEOUT_MS,
    }).listStores();
  } catch (err) {
    if (err instanceof ShipStationError && err.status === 401) {
      fail("ShipStation didn't accept the API key and secret. Copy both again from Settings → Account → API Settings.");
    }
    if (err instanceof ShipStationError && err.status === 0) {
      fail(`Couldn't reach ShipStation (${errorText(err)}). Try again in a minute.`);
    }
    fail(errorText(err));
  }

  const name = (store: Record<string, unknown>) => String(store.storeName || store.storeId);

  if (settings.store_id) {
    const store = stores.find((s) => String(s.storeId) === settings.store_id);
    if (!store) {
      fail(
        `Connected to ShipStation, but the account has no store with the ID ${settings.store_id}. Its stores: ${
          stores.map((s) => `${name(s)} (${s.storeId})`).join(', ') || 'none'
        }.`,
      );
    }
    return { message: `Connected to ShipStation store ${name(store)}.` };
  }

  return {
    message: stores.length
      ? `Connected to ShipStation. Stores in this account: ${stores.map(name).join(', ')}.`
      : 'Connected to ShipStation.',
  };
}
