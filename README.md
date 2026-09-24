# ShipStation integration

Two-way order and shipment sync between Swell and [ShipStation](https://www.shipstation.com),
built to replace the native ShipStation integration.

## What it adds over the native integration

| | Native | This app |
| --- | --- | --- |
| Push trigger | Paid orders only | Paid, submitted, or manual |
| Order edits | Never re-sent | Address and item changes re-pushed |
| Cancellations | Not sent | Order marked cancelled in ShipStation |
| Partial shipments | All-or-nothing fulfillment | A Swell shipment per ShipStation shipment, with per-item quantities |
| Voided labels | Ignored | Matching Swell shipment canceled |
| Failures | Silent | Recorded on the order and shown in the dashboard |
| Order numbering | Fixed | Optional prefix, plus ShipStation store mapping |

## How it works

```
order is paid (or submitted)
   → order-push maps the order and upserts it in ShipStation via /orders/createorder
   → orderKey is the Swell order id, so every later push updates the same order

label bought in ShipStation
   → SHIP_NOTIFY / ITEM_SHIP_NOTIFY webhook hits shipstation-webhook
   → shipments are fetched from the resource_url (a ShipStation API host, with your API
     credentials) and matched back to Swell line items
   → a Swell shipment is created with tracking, carrier and per-item quantities
   → the platform recomputes the order's fulfillment state on its own
```

Orders are matched by `orderKey`, which is always the Swell order id — that is what makes a
repeated push an update rather than a duplicate. Line items are matched by `lineItemKey`,
which is the Swell order item id, and this is what makes accurate partial shipments
possible. SKU matching is the fallback for items that predate the app.

## Getting started

1. Clone this repository and install the Swell CLI.

```bash
npm install @swell/cli
```

2. Push the app to your test store.

```bash
cd /path/to/shipstation-integration

npm install

swell login

swell app push
```

3. Install to the live environment. ShipStation's webhooks reach the live environment only,
   so this step is required before shipment sync can work at all.

```bash
swell app version minor
swell app install
```

4. In **Apps → ShipStation → Settings**, fill in:
   - **API key** and **API secret** from ShipStation → Settings → Account → API Settings.
   - **Webhook secret** — any random string of 16+ characters. It is added to the callback
     URL, but Swell does not currently pass it through (see "Webhook authentication" under
     Notes). It is still required for inline test payloads.
   - **Enable ShipStation sync**.

5. Register the webhooks.

```bash
swell api post /functions/shipstation/setup
```

   The response reports whether the credentials work, the callback URL it registered, and
   the state of each subscription. `GET` the same endpoint to check configuration without
   changing anything. A daily cron (`webhook-reconcile`) re-checks the subscriptions and
   repairs them if ShipStation drops one or the secret is rotated.

6. **Disable the native ShipStation integration.** Otherwise every order is pushed twice.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Enable ShipStation sync | off | Master switch |
| API key / API secret | — | ShipStation account API credentials |
| ShipStation store ID | — | Optional; assigns pushed orders to one ShipStation store |
| Push orders to ShipStation | When paid | Or when submitted, or manual only |
| Order number prefix | — | e.g. `SW-`, for accounts fed by several channels |
| Sync order edits | on | Re-push when the shipping address or items change |
| Sync cancellations | on | Mark cancelled in ShipStation |
| Webhook secret | — | Added to the callback URL. Refused if wrong; required for inline test payloads |
| Callback URL override | — | Only needed if the derived URL is wrong, or for a dev tunnel |
| Create shipments from ShipStation | on | Turn notifications into Swell shipments |
| Accept test webhook payloads | off | Development aid, see Testing below |

## Sync status and re-syncing

Every order gets a **ShipStation** tab in the order editor showing the sync status, the
ShipStation order number and id, when it last synced, how many shipments came back, and the
last error. The order list gains a **ShipStation** column and a **ShipStation errors** tab
for finding failures quickly.

`sync_status` values: `pending`, `synced`, `error`, `skipped` (ShipStation already shipped or
cancelled the order and no longer accepts changes), `canceled`.

To re-push one order, switch on **Re-sync on save** in that tab and save. The flag clears
itself once the push completes. From the CLI:

```bash
# one order
swell api post /functions/shipstation/resync --body '{"order_id":"<id>"}'

# up to 10 orders that previously failed
swell api post /functions/shipstation/resync --body '{"sync_status":"error"}'
```

## Partial shipments

Ship part of an order in ShipStation and the matching Swell shipment covers only those
items and quantities, leaving the order in `delivery_pending`. Ship the rest and the order
becomes `complete`. Nothing sets the delivered flag directly — the platform derives it from
the shipment item quantities, so the two systems cannot drift.

Quantities are capped at what is still awaiting fulfillment, and each ShipStation
`shipmentId` is stored on the Swell shipment, so a replayed or duplicated webhook delivery
is recognised and skipped instead of double-counting. A voided label cancels the matching
Swell shipment and the order's fulfillment state recomputes accordingly.

Carrier and service arrive as ShipStation codes and are stored as readable names
(`carrier_name`, `service_name`) rather than Swell carrier ids, so no carrier configuration
is required on the Swell side.

## Testing

```bash
npm run typecheck
npm run test
```

The unit suite covers order mapping, shipment ingestion, and the API client's retry and
error handling with no network access. Integration tests read live store data through your
CLI session to catch drift in the real order shape.

To exercise shipment ingestion without a ShipStation account, switch on **Accept test
webhook payloads** and post shipments inline:

```bash
swell api post '/functions/shipstation/shipstation-webhook?secret=<webhook_secret>' --body '{
  "resource_type": "SHIP_NOTIFY",
  "shipments": [{
    "shipmentId": 700001,
    "orderKey": "<swell_order_id>",
    "trackingNumber": "1Z-TEST",
    "carrierCode": "ups",
    "serviceCode": "ups_ground",
    "shipmentItems": [{ "lineItemKey": "<swell_order_item_id>", "quantity": 1 }]
  }]
}'
```

Turn the setting off again when finished. Keep it off in production.

## Notes and limitations

- **Webhook authentication.** ShipStation's notification carries no shipment data, only a
  `resource_url`. The app fetches that URL itself, only from a ShipStation API host
  (`ssapi.shipstation.com` or a numbered one like `ssapi12.shipstation.com`) and only a
  `/shipments` listing, using your API credentials. What it ingests is always your real
  ShipStation data, whoever sent the notification, and a repeat is deduped. That is the
  authentication, because the `?secret=` in the callback URL never arrives: Swell's
  public-route proxy passes a function the request body *or* the query string, never both.
  This was measured live on 2026-09-24 and filed with the platform team (Asana
  1218816382065204). A secret that does arrive and is wrong is refused, and inline test
  shipments (**Accept test webhook payloads**) require it.

- **Webhooks need the live environment, and the app's ObjectId.** Public route functions
  resolve at `https://<store_id>.swell.store/functions/<app ObjectId>/<name>`, which serves
  the live environment. The ObjectId is the 24-character id in `.swellrc`; the string-id
  form (`/functions/shipstation/…`) only resolves for callers with a Swell API key, so
  ShipStation's deliveries to it 404. Setup looks the ObjectId up and reports an error
  rather than registering a URL it cannot build. An app that has only been pushed to test answers 404 there, so run
  `swell app install` before registering webhooks — or point **Callback URL override** at a
  tunnel while developing.
- **ShipStation can be slow.** A rejected credential takes about six seconds to come back,
  and functions have a 10 second budget. Every call is bounded (4s, 2s for the pre-update
  status probe) so a slow response is recorded on the order instead of silently timing out.
- **ShipStation will not update an order it has already shipped or cancelled.** Those edits
  are skipped and recorded as `skipped` with an explanation rather than retried.
- **App settings cannot be used in function conditions.** A `model.conditions` entry
  referencing `$settings` stops the platform dispatching the event at all, so all gating is
  done in the handlers. Similarly `$data.<field>` conditions match every update, because
  `$data` resolves against the whole record; the handlers read `$event.data`, which holds
  only the changed fields.
- Orders with no shippable items (gift cards, subscriptions only) are not sent to
  ShipStation and are recorded as `skipped`.
- Rate limiting: ShipStation allows roughly 40 requests per minute. A short `Retry-After`
  is waited out inline; anything longer is reported as retryable so the platform redelivers.
- Not included: live shipping rates at checkout, inventory sync, and the ShipStation v2 API.

## Contributing

Contributions are welcome! Visit the [Swell Discord](https://discord.gg/VakSbyjDGZ) or
[GitHub discussions](https://github.com/orgs/swellstores/discussions/) to get help and share
ideas.

## License

This project is licensed under the MIT License - see [LICENSE.md](LICENSE.md) file for details.
