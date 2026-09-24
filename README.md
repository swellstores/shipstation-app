# ShipStation for Swell

## What the app does

Connects a Swell store to [ShipStation](https://www.shipstation.com). Paid orders appear in
ShipStation automatically, ready to pick, pack and buy labels for. When a label is bought
there, the app creates the shipment back in Swell with the tracking number, carrier and the
exact items shipped, so the order's fulfillment status, and the tracking the customer sees,
stay correct without re-typing anything. It replaces Swell's built-in ShipStation integration
and does everything that one does, plus partial shipments, order edits, cancellations and a
visible sync status on every order.

| | Built-in integration | This app |
| --- | --- | --- |
| When orders are sent | When paid | When paid, when submitted, or only on request |
| Orders open at setup | Sent on first sync | Sent after setup, a few every five minutes |
| Order edits | Never re-sent | Address and item changes re-sent |
| Cancellations | Not sent | Order marked cancelled in ShipStation |
| Partial shipments | One shipment per label | One Swell shipment per ShipStation shipment, with per-item quantities |
| Voided labels | Ignored | Matching Swell shipment canceled |
| Sync problems | Not shown | Recorded on the order, with an errors tab in the order list |
| Order numbers | Swell number | Swell number, with an optional prefix |
| Metric weights | Kilograms converted incorrectly | Converted correctly |

## Features

### Orders sent to ShipStation

**What it does.** Each order is created in ShipStation with its billing and shipping
addresses, customer email, line items, totals, requested shipping service and gift message.
Each line item carries its SKU, quantity, weight, product options (size, colour, engraving
and so on), and the price the customer actually paid per unit: list price plus tax, less
discount, the same figure the built-in integration sends. ShipStation uses it for customs
values and packing slips. Only physical items are sent; an order with nothing to ship
(gift cards only, for example) is left out and marked **Skipped**.

The Swell order id is sent as ShipStation's `orderKey`, so sending the same order again
updates it rather than creating a duplicate. Held orders are sent as *On hold*, unpaid ones
as *Awaiting payment*.

**Where it shows up.** In ShipStation's order list, under the store set in **ShipStation
store ID** (or the default store), numbered with the Swell order number and the optional
prefix.

**How it's built.** `functions/order-push.ts` on `order.paid` and `order.submitted`; the
**Push orders to ShipStation** setting picks which one acts. Mapping is in
`functions/lib/order-mapper.ts`, sending in `functions/lib/push.ts`.

### Orders that were already open at setup

**What it does.** After the app is set up, orders that are already paid and still have items
to ship are sent too, five at a time every five minutes, oldest first, until none are left.
It's the same set the built-in integration sends on its first sync, so a store switching over
doesn't start with an empty ShipStation. It then stays idle, because every order it touches
is marked with a sync status. Turn it off with **Send existing orders**.

**How it's built.** `functions/order-backfill.ts`, a cron every five minutes.

### Order edits and cancellations

**What it does.** If an order's shipping address or items change after it was sent, it is
sent again (**Sync order edits**). If it is canceled in Swell, it is marked cancelled in
ShipStation (**Sync cancellations**). ShipStation refuses changes to orders it has already
shipped or cancelled; those are recorded as **Skipped** with the reason, not retried.

**How it's built.** `functions/order-update.ts` on `order.updated`, reading only the changed
fields; `functions/order-cancel.ts` on `order.canceled`.

### Shipments created from ShipStation

**What it does.** When a label is bought in ShipStation, a Swell shipment is created with the
tracking number, carrier, service and the items and quantities in that package. Ship part of
an order and the order stays awaiting fulfillment; ship the rest and it completes. Swell works
out the fulfillment status from the shipped quantities, so the two systems can't drift.
Voiding a label in ShipStation cancels the matching Swell shipment. A notification that
arrives twice is recognised and not counted twice.

**Where it shows up.** The order's shipments and fulfillment status in the Swell dashboard,
and anywhere the store shows tracking to the customer. Carrier and service are stored as
names, so no carrier setup is needed in Swell.

**How it's built.** `functions/shipstation-webhook.ts`, a public route ShipStation calls on
`SHIP_NOTIFY` and `ITEM_SHIP_NOTIFY`; matching and shipment creation are in
`functions/lib/shipment-ingester.ts`. ShipStation's notification contains only a link; the
app fetches the shipments from ShipStation's API with the store's own credentials, so it only
ever records real ShipStation data.

### Sync status on every order

**What it does.** Every order gets a **ShipStation** tab showing whether it synced, its
ShipStation order number and id, when it last synced, how many shipments came back, and the
last error if there was one. The order list gets a **ShipStation** column and a
**ShipStation errors** tab.

| Status | Meaning |
| --- | --- |
| Pending | Waiting to be sent |
| Synced | Accepted by ShipStation |
| Error | The last attempt failed; the error is shown on the order |
| Skipped | Not sent: nothing to ship, or ShipStation has already shipped or cancelled it |
| Canceled | The cancellation was sent |

**How it's built.** `content/orders.json` (the tab, column and errors tab) and
`models/orders.json` (the fields, stored under the app's own namespace on the order).

### Re-sending orders

**What it does.** Switch on **Re-sync on save** in an order's ShipStation tab and save; the
order is sent again and the switch turns itself off. Useful after fixing whatever caused an
error.

**How it's built.** `functions/order-update.ts` reacts to the flag. `functions/resync.ts` is
the same thing as an API route, for one order or for up to ten at a time by status.

### Webhook registration and upkeep

**What it does.** Setup registers the two ShipStation webhooks the app needs. Once a day the
app checks they're still there and still point at the right address, and repairs them if
not. When the app is switched off, the same daily check removes them, so ShipStation stops
calling a store that isn't listening.

**How it's built.** `functions/setup.ts` (a private route), `functions/webhook-reconcile.ts`
(daily cron), `functions/lib/webhooks.ts`.

## Setup

### What you need from ShipStation

A ShipStation account on a plan that includes API access, and its **API key** and **API
secret** from ShipStation → **Settings → Account → API Settings**.

### Install and configure

1. Install **ShipStation** from the Swell App Store.
2. **Turn off the built-in ShipStation integration** (Settings → Integrations) if it's on.
   Otherwise both send every order and ShipStation gets duplicates.
3. Open **Apps → ShipStation → Settings** and fill in the settings below. At minimum: API key,
   API secret, and **Enable ShipStation sync**.
4. Register the webhooks by calling the setup route once with the store's secret API key:

   ```bash
   curl -X POST "https://<store-id>.swell.store/functions/shipstation/setup" \
     -u "<store-id>:<secret-key>"
   ```

   The response confirms the credentials work, lists the ShipStation stores on the account
   (with the ids for **ShipStation store ID**), and reports each webhook it registered. A
   `GET` to the same address reports the same without changing anything.
5. Orders already open are sent over the next few minutes. New orders are sent as they're
   paid.

### Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Enable ShipStation sync | Off | Master switch. While off, nothing is sent, shipment notifications are ignored, and the daily check removes the webhooks. |
| API key | — | ShipStation API key. |
| API secret | — | ShipStation API secret. Regenerating the key in ShipStation invalidates both. |
| ShipStation store ID | — | Optional. Puts orders in a specific ShipStation store and limits webhooks to it. Leave empty for the default store. |
| Push orders to ShipStation | When paid | When an order is first sent: when paid, when submitted, or only on request (Re-sync on save). |
| Order number prefix | — | Optional. Added in front of the Swell order number, for example `SW-`, when several channels feed one ShipStation account. |
| Send existing orders | On | After setup, send the orders that are already paid and waiting to ship. |
| Sync order edits | On | Re-send an order when its shipping address or items change. |
| Sync cancellations | On | Mark the order cancelled in ShipStation when it's canceled in Swell. |
| Webhook secret | — | Any random string of 16+ characters. Added to the callback address and required for test payloads. See *Limits*. |
| Callback URL override | — | Leave empty. Only for pointing ShipStation somewhere else, such as a tunnel during development. |
| Create shipments from ShipStation | On | Turn labels bought in ShipStation into Swell shipments. |
| Accept test webhook payloads | Off | Development only. Keep it off. |

## Day-to-day use

- **Nothing to do for a normal order.** It appears in ShipStation when paid; buy the label
  there as usual and the Swell order is marked shipped with tracking.
- **Shipping in parts.** Ship some items now and the rest later; each label becomes its own
  Swell shipment, and the order completes when everything has shipped.
- **Changing an order.** Edit it in Swell before it ships and the change follows to
  ShipStation. After it's shipped, ShipStation won't accept changes, and the order says so.
- **Checking for problems.** The **ShipStation errors** tab in the order list shows every
  order that failed. Open one, read **Last error** on its ShipStation tab, fix the cause (for
  example an address ShipStation rejected), then switch on **Re-sync on save** and save.
- **Before uninstalling**, remove the webhooks (see *Limits*).

## Limits and known issues

- **Live environment only for shipments.** ShipStation's notifications reach a store's live
  environment. In the test environment orders are still sent, but shipments don't come back.
- **Uninstalling doesn't remove the webhooks.** Swell doesn't notify an app when it's
  uninstalled. Switch the app off and wait for the daily check, or remove them straight away
  with the setup route before uninstalling:

  ```bash
  curl -X POST "https://<store-id>.swell.store/functions/shipstation/setup" \
    -u "<store-id>:<secret-key>" -H "Content-Type: application/json" \
    -d '{"action":"remove_webhooks"}'
  ```

- **The webhook secret isn't what protects the webhook today.** Swell currently drops the
  query string from calls like ShipStation's, so the secret in the callback address never
  reaches the app. The app doesn't rely on it: it only acts on shipments it fetches itself
  from ShipStation with the store's credentials. A secret that does arrive and is wrong is
  still refused. This is filed with the Swell platform team.
- **ShipStation won't change shipped or cancelled orders.** Edits after that point are
  recorded as Skipped.
- **Rate limits.** ShipStation allows about 40 API requests a minute. Short pauses are waited
  out; longer ones are retried later. Sending existing orders is paced at five every five
  minutes to stay well inside that.
- **Existing orders are found by scanning.** The first sync looks for paid, unshipped orders
  the app hasn't seen. On stores with a very large number of open orders it takes a while to
  catch up.
- **Failed orders aren't retried forever.** An order that errors stays in **ShipStation
  errors** until it's fixed and re-synced.
- **Not included:** live shipping rates at checkout, inventory sync, returns, and
  ShipStation's v2 API.

## Development

The repository is the source of truth. `.swellrc` is committed on purpose: it pins the app to
its official record on the Swell Apps account, so a clone pushes to the same app. Never
commit a `.swellrc` created against another store.

```bash
npm install
npm run typecheck
npm run test
```

The unit tests cover order mapping, the existing-order sync, shipment ingestion, the
ShipStation API client (retries, errors, which hosts it will fetch from), the webhook route,
the callback address and webhook removal, with no network access. The integration tests in
`test/integration/` read real data through your Swell CLI session.

Push to Swell Apps and check that everything registered, since a push can succeed with
nothing registered if the build failed:

```bash
swell switch swell-apps
swell app push
swell inspect functions --app=.
```

You should see eight functions: `order-push`, `order-update`, `order-cancel`,
`order-backfill`, `shipstation-webhook`, `setup`, `resync` and `webhook-reconcile`.

To test shipment creation without a ShipStation account, switch on **Accept test webhook
payloads** and post shipments directly:

```bash
swell api post '/functions/shipstation/shipstation-webhook?secret=<webhook secret>' --body '{
  "resource_type": "SHIP_NOTIFY",
  "shipments": [{
    "shipmentId": 700001,
    "orderKey": "<swell order id>",
    "trackingNumber": "1Z-TEST",
    "carrierCode": "ups",
    "serviceCode": "ups_ground",
    "shipmentItems": [{ "lineItemKey": "<swell order item id>", "quantity": 1 }]
  }]
}'
```

Turn it off again afterwards.

Things worth knowing before changing the code:

- **Public route addresses use the app's ObjectId** (the id in `.swellrc`):
  `https://<store-id>.swell.store/functions/<app ObjectId>/shipstation-webhook`. The form with
  the app's name only works for callers that send a Swell API key, which ShipStation doesn't.
  Setup looks the ObjectId up, and reports an error rather than registering an address it
  can't build.
- **Functions have 10 seconds.** Every ShipStation call is bounded (4 seconds, 2 for status
  checks), so a slow response is recorded on the order instead of timing out silently.
- **Don't put app settings in function `conditions`.** A condition on `$settings` stops the
  event being delivered at all, and `$data` conditions match every update. All gating is in
  the handlers, which read `$event.data` for the fields that actually changed.
- **A record that doesn't exist makes Swell return an error (400), not `null`.** Wrap
  existence checks accordingly.

## Contributing

Issues and pull requests are welcome. For questions, visit the
[Swell Discord](https://discord.gg/VakSbyjDGZ) or
[GitHub discussions](https://github.com/orgs/swellstores/discussions/).
