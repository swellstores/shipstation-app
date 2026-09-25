ShipStation for Swell connects your store to ShipStation, so you can pick, pack and buy labels in ShipStation while Swell stays the record of what shipped. Paid orders appear in ShipStation on their own. When you buy a label there, the order in Swell is marked shipped with the carrier, the tracking number and the exact items in the box. Nothing is typed twice, and your customers see accurate tracking.

It replaces Swell's built-in ShipStation integration and does everything that integration does, plus partial shipments, order edits, cancellations, voided labels and a sync status on every order.

## Orders go to ShipStation automatically

Each order is sent with its billing and shipping addresses, customer email, requested shipping service, gift message and totals. Every line item carries its SKU, quantity, weight, product options such as size, colour or engraving, and the price the customer actually paid, which ShipStation uses for packing slips and customs values. Only physical items are sent, so an order of gift cards alone never clutters your queue.

You choose when an order is sent: when it's paid, when it's submitted, or only when you ask. An optional order number prefix, such as "SW-", keeps Swell orders easy to spot when several sales channels feed one ShipStation account. Sending the same order again updates it in ShipStation instead of creating a duplicate.

## Your open orders come with you

When you switch the app on, the orders that are already paid and waiting to ship are sent to ShipStation too, a few every five minutes, oldest first. You don't start with an empty queue, and ShipStation's rate limits are respected.

## Tracking comes back to Swell

Buy a label in ShipStation and a shipment is created on the Swell order with the carrier, service, tracking number and the items and quantities in that package. The order's fulfillment status updates to match, and the tracking is available wherever your store shows it to customers.

- **Partial shipments.** Ship part of an order today and the rest next week. Each label becomes its own shipment, and the order completes when the last item ships.
- **Voided labels.** Void a label in ShipStation and the matching Swell shipment is canceled.
- **No double counting.** A notification ShipStation sends twice is recognised and recorded once.

Shipments are only ever created from data the app reads back from ShipStation with your own credentials.

## Edits and cancellations follow the order

Change a shipping address or the items on an order in Swell before it ships, and the order is updated in ShipStation. Cancel it in Swell and it's cancelled in ShipStation. Once ShipStation has shipped or cancelled an order it won't accept changes, and the order in Swell says so, so nothing fails silently.

## See the sync status on every order

Every order gets a ShipStation tab showing whether it synced, its ShipStation order number, when it last synced, how many shipments came back and, if something went wrong, the error ShipStation returned. The order list gains a ShipStation column and a ShipStation errors view, so problems are easy to find. Fix the cause, switch on "Re-sync on save", and the order is sent again.

## Setup

You need a ShipStation account on a plan with API access, and its API key and secret from Settings → Account → API Settings in ShipStation.

1. Install the app and turn off Swell's built-in ShipStation integration, so orders aren't sent twice.
2. Enter your API key and secret in the app's settings, choose when orders are sent, and switch the app on.
3. Run the app's one-time setup to connect ShipStation's shipment notifications. The README walks through it.

Once a day the app checks that ShipStation's notifications are still connected and repairs them if they aren't.

## Good to know

- Tracking comes back to your store's live environment. In test mode orders are still sent to ShipStation, but shipments don't return.
- Live shipping rates at checkout, inventory sync and returns are not included.
- This app is built and supported by Swell and is open source at github.com/swellstores/shipstation-app.
