Send your Swell orders to ShipStation, where you pick, pack and buy labels. When you buy a label, the order in Swell gets a shipment with the carrier, tracking number and the items in the package, and its fulfillment status updates to match.

The app replaces Swell's built-in ShipStation integration. It also sends order edits and cancellations to ShipStation, records partial shipments item by item, and shows a sync status on every order.

- **Orders ready to ship.** Paid orders, or submitted ones if you choose, go to ShipStation with their addresses, SKUs, product options, weights and the shipping service the customer chose. An optional prefix sets Swell orders apart in a shared ShipStation account.
- **Open orders come along.** The paid orders already waiting to ship when you set up the app are sent too, 5 every 5 minutes, oldest first.
- **Tracking back in Swell.** Each label you buy becomes a Swell shipment with the carrier, service, tracking number and the items in the package.
- **Partial shipments.** Ship an order in parts, and each label becomes its own shipment. The order is fulfilled when the last item ships.
- **Edits and cancellations follow.** Change an order's shipping details or items, or cancel it, and the order is updated in ShipStation while it's still open there.
- **Sync status on every order.** A ShipStation tab shows the status, the ShipStation order number, the shipments received and the last error. A ShipStation errors tab in the order list collects failed orders, and Re-sync on save sends one again.

Setup takes a few minutes. In ShipStation, copy your API key and secret from Settings → Account → API Settings. In Swell, deactivate the built-in ShipStation integration under Integrations, enter the keys and a webhook secret in the app settings, and turn on Enable ShipStation sync. Then run the app's setup route to register the shipment webhooks, or let the app's daily check register them. Tracking comes back to your live environment.
