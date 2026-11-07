# Tip jar

GitHub builds always show **More → Tip jar**, without requiring Developer
Options. Users can choose either destination (USDC on Base is selected initially):

| Token | Network | Recipient |
| --- | --- | --- |
| USDC | Base | `0x5424bcf743D265BA8Ac4ACdE0d0A5DfC187eeB05` |
| USDT | Solana | `59Nqb3jEvexJV7HAwHJDMrqnipaxhN7VJbJe7C7pz7uV` |

The currency selector uses the issuers' official token logos, bundled locally
under `assets/brand/`. Selecting a destination updates the network instructions, full selectable
address, QR code, and copy action together. A copy icon sits inside the bordered
address box. Switching destinations clears earlier copy feedback. Users select
the displayed token and network in their own wallet and confirm the transfer there.
Whip does not initiate or track the transfer, invoke store billing, or report a
payment as completed. The QR code contains only the address; it does not select
the token or network for the wallet.

The $5 store tip remains a developer preview, visible only when **Developer
Options** is enabled under More → Settings → Developer. Store builds disable
Developer Options, so the tip jar stays hidden from App Store and Google Play
users during setup. Submitting feedback is not required. Crypto tip controls
appear only on the explicit `github` distribution channel.

Store purchasing is restricted to `google-play` and `app-store` builds. Remove
the Developer Options visibility gate for stores only when the products are
ready for public rollout.
Each tip is an optional, repeatable, one-time purchase. It grants no entitlement,
feature, membership, priority, or other benefit.

## Product setup

Use the same product identifier on both stores: `whip_tip_5`.

1. **App Store Connect:** create a **Consumable** in-app purchase with that ID,
   a display name such as “Support Whip”, and a description explaining that it
   is an optional tip with no extra benefits. Set the United States price to
   **USD 5.00** (use **See Additional Prices** in the price picker), configure
   availability and localized prices, and submit it for
   review with the app. Include a review screenshot of More → Tip jar.
2. **Google Play Console:** create and activate a **one-time product** with the
   same ID and a **Buy** purchase option. Set the United States price to
   **USD 5.00**, review localized prices and regional availability, and enable
   the backwards-compatible Buy option where required by Play. Bulk pricing
   rounds USD 5.00 to USD 4.99 in the United States; edit that country's price
   directly to keep the tip at exactly USD 5.00.
3. **RevenueCat:** import both products into Whip’s existing project and mark
   them **consumable**. Do **not** attach them to `whip_rancher` or any other
   entitlement. The app fetches this product directly, so no offering or
   package is required. RevenueCat manages finishing/consuming purchases so
   users can leave another tip.

The app always displays the store’s `priceString`, including its localized
currency. The USD amount is configured in the consoles, not charged or
hardcoded by the app. Until the product is available, the section displays an
unavailable message and a retry action; it cannot start a purchase.

Use the existing platform public SDK keys and store distribution channels
described in [Rancher membership](rancher-membership.md#build-configuration).
No new SDK, API key, subscription, or server endpoint is needed.

## Dashboard setup status — 2026-10-21

Configured through the OpenCLI browser workflow:

| Service | Product | Status |
| --- | --- | --- |
| App Store Connect | `whip_tip_5`, Apple ID `6825197147` | Waiting for Review, submitted with iOS 1.9.1 (build 3) on 2026-10-21. USD 5.00 base price, generated localized prices, all countries/regions selected, six product localizations, developer-preview screenshot, and review notes. The tip remains hidden in the app. |
| RevenueCat — App Store | `prod5ec754c556` | `whip_tip_5` created as a consumable with no entitlements or offerings. Required in-app purchase key validated. Product-status checks are unavailable because optional App Store Connect API access is not configured. |
| RevenueCat — Play Store | `prodb6fe2460c2` | `whip_tip_5` created as a consumable with no entitlements or offerings. Store status verified as Published after Play activation. |
| Google Play Console | `whip_tip_5`, purchase option `buy` | Created and Active. Backwards-compatible Buy option, exact USD 5.00 US price, generated localized prices, and availability in 174 countries/regions. |

The updated Apple Paid Apps Agreement was accepted with the account holder's
explicit authorization and is Active. Apple requires this first consumable to
be submitted with a new app version. The account holder requested submission
with iOS 1.9.1 (build 3) while keeping the tip jar hidden. Store builds hide
Developer Options, so this build provides no purchase-screen entry point for
the product. Both the app and purchase review notes disclose that limitation.
Actual sandbox checkout testing has not been performed.

Apple accepted the app and consumable into review submission
`b1319560-6f26-4a60-97d1-a033d4359b88` at 2026-10-21 14:50:48 UTC. Both are
Waiting for Review. The app retains its existing automatic release after
approval setting.

The review screenshot is an unedited capture from the existing iPhone 17 Pro
simulator running the GitHub-channel arm64 build with the current tip jar UI:
[`whip_tip_5-developer-preview.jpg`](../fastlane/metadata/ios/iap-review/whip_tip_5-developer-preview.jpg).
It shows the unavailable state because GitHub builds do not invoke store
billing. The saved review notes explain this limitation and the request for
product review ahead of a future tip-jar rollout. The submitted notes are kept
in [`whip_tip_5-review-notes.txt`](../fastlane/metadata/ios/iap-review/whip_tip_5-review-notes.txt).
A public tip rollout needs a working App Store purchase-screen capture and
sandbox purchase testing.

## Purchase behavior

Only the native store purchase result triggers the thank-you message. Cancelling
is silent. Pending payments show a pending message and disable another tip in
that screen session; they do not display a success message. Other failures show
an error asking the user to check their store purchase history before retrying.
Rapid taps cannot open multiple purchase flows. A completed tip leaves the
button available for another separate purchase.

The tip jar uses a different product from the three
[request-specific tips](request-tipping.md). It does not create feedback or tip
intents. RevenueCat records its transactions; the feedback webhook ignores this
product, so a general tip cannot be assigned to an earlier feedback request.
Consumable tips do not need a restore action because they unlock no access.

## Release validation

- On a GitHub build with Developer Options disabled, open More → Tip jar.
  Switch between USDC/Base and USDT/Solana, verify each network's instructions,
  scan each QR code, and copy each address. Both QR and clipboard must match
  the selected recipient above; neither action indicates payment success.
- Confirm normal App Store and Google Play builds keep the tip jar hidden and
  never display the crypto address or controls.
- Test the product with Play license testers/internal testing and Apple sandbox
  testers/TestFlight, using the real platform public SDK keys.
- For store purchase testing, enable the tip jar in a dedicated test build; the
  current Developer Options gate intentionally hides it in normal store builds.
- Verify the localized price, a successful purchase, a second purchase,
  cancellation, pending/Ask to Buy, and an unavailable product or network error.
- Confirm Rancher membership is unchanged and the RevenueCat transaction shows
  `whip_tip_5`. Keep production payments unavailable until both store products
  are configured and approved/active.

References: [RevenueCat non-subscription purchases](https://www.revenuecat.com/docs/platform-resources/non-subscriptions),
[Apple in-app purchase guidelines](https://developer.apple.com/app-store/review/guidelines/#in-app-purchase).
