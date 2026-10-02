# Rancher membership

Whip uses RevenueCat for the optional Rancher cosmetic tier. Cowboy remains
free forever and includes every functional feature. Rancher is a one-time
lifetime purchase; it is not a subscription and has no renewal or expiration.
Eligible new installations receive a non-renewing, app-managed five-day
Rancher trial. RevenueCat CustomerInfo remains the source of truth for lifetime
ownership.

## Product contract

- Production lifetime price: USD 29.99. The purchase comparison displays the
  localized store price returned by RevenueCat when available and uses the
  confirmed USD price as a fallback while the catalog is unavailable.
- Entitlement: `whip_rancher`
- Offering: `default`, selected as the current offering
- Package: `$rc_lifetime`
- RevenueCat product type: non-consumable
- Google Play one-time product ID: `lifetime`
- Google Play purchase option: Buy, with purchase-option ID `buy`

An active `customerInfo.entitlements.active.whip_rancher` grants Rancher. A
missing or inactive entitlement resolves to Cowboy. Purchasing and restoring
must update CustomerInfo; the app never sets Rancher access optimistically.

## Five-day app-managed trial

- Eligibility begins with installations made on or after
  `2026-08-30T06:05:12.000Z`; existing installations are not enrolled.
- Access starts at the platform-reported first installation time and ends
  exactly five days later, including across app restarts and updates.
- The trial unlocks the Rancher cosmetic capabilities but does not create a
  RevenueCat entitlement and never initiates or schedules a charge.
- Users can buy the existing lifetime package during the trial. A successful
  lifetime purchase continues after the trial expires.
- Whip has no authenticated account, so uninstalling and reinstalling can be
  reported by the platform as a new installation and restart the local trial.

Google Play and RevenueCat do not need a trial product, subscription, base
plan, or introductory offer for this flow. Their existing one-time lifetime
product mapping remains unchanged.

## Build configuration

The Expo configuration accepts these public build-time values:

```bash
export WHIP_DISTRIBUTION_CHANNEL='app-store' # app-store | google-play | github
export WHIP_REVENUECAT_IOS_PUBLIC_SDK_KEY='appl_...'
export WHIP_REVENUECAT_ANDROID_PUBLIC_SDK_KEY='goog_...'
export WHIP_RANCHER_WEB_PURCHASE_URL='https://...' # optional GitHub APK fallback
```

Local development uses the configured RevenueCat Test Store public key
`test_DlbxSQbXcMlbbZrHJdiUgunsAOx` unless
`WHIP_REVENUECAT_TEST_PUBLIC_SDK_KEY` overrides it. Production builds never
fall back to the test key. Public RevenueCat SDK keys and checkout URLs may be
embedded in the client; secret RevenueCat and payment-provider keys must never
be added.

The iOS device build defaults to `app-store`. The GitHub APK and Google Play
workflows explicitly set `github` and `google-play` respectively. GitHub APKs
open the RevenueCat package/offering web checkout URL when RevenueCat supplies
one, falling back to `WHIP_RANCHER_WEB_PURCHASE_URL`. They never invoke Google
Play Billing merely because the platform is Android.

## RevenueCat project `0334994b`

The existing Test Store catalog already has the correct identifiers and
relationships: `default` → `$rc_lifetime` → non-consumable `lifetime` →
`whip_rancher`. Change its USD price from 99.99 to the confirmed production
price of 29.99 before final purchase testing.

Add the Google Play app to the same RevenueCat project, import the Google Play
`lifetime` product, mark it non-consumable in RevenueCat, attach it to
`whip_rancher`, and select it as the Google Play product for `$rc_lifetime` in
the current `default` offering. Verify that a completed purchase reports an
active `whip_rancher` entitlement.

Whip presents its own Cowboy-versus-Rancher comparison screen, then purchases
the configured lifetime package through the RevenueCat SDK. Restore Purchases
remains available on native store builds. A RevenueCat-hosted Paywall and
Customer Center are not required because there is no subscription to manage.

## Google Play Console

1. Under **Monetize → Products → One-time products**, create product ID
   `lifetime`.
2. Add a **Buy** purchase option with purchase-option ID `buy`.
3. Configure it as a permanent, non-consumable unlock. Do not consume the
   purchase after delivery.
4. Set the United States price to USD 29.99, review Play's generated localized
   prices, and enable the regions where Whip is distributed.
5. Mark the Buy option as backwards compatible when Play exposes that setting,
   then activate the product and purchase option.
6. Import the product into RevenueCat and mark it non-consumable there as well.
7. Test purchase, cancellation, pending purchase, refund/revocation, reinstall,
   and Restore Purchases behavior with Play license testers.

Do not create a subscription, base plan, billing period, introductory offer, or
free trial for Rancher.

## Other stores

- App Store Connect: when iOS purchasing is enabled, create a non-consumable
  in-app purchase at the equivalent localized lifetime price and attach it to
  the same RevenueCat entitlement/package. Its product identifier still needs
  to be selected in App Store Connect; do not copy an unconfirmed identifier
  into application code.
- RevenueCat Web Billing: when GitHub-build purchasing is enabled, create a
  one-time lifetime product at the equivalent localized price, attach it to
  `$rc_lifetime`, and configure checkout identity continuity. Expose its
  RevenueCat checkout URL or set `WHIP_RANCHER_WEB_PURCHASE_URL`.

Existing consumable tip products and feedback flows remain unchanged.

## App Store and Google Play rollout

EAS production iOS builds explicitly use the `app-store` distribution channel
and the EAS `production` environment. Set
`WHIP_REVENUECAT_IOS_PUBLIC_SDK_KEY` there to the Apple app's `appl_...` public
SDK key (plain text or sensitive visibility, so EAS can resolve app config).
The iOS pre-install hook rejects production builds without that key or channel.
Configure the App Store product mapping described above before purchase testing.

The Google Play app bundle CI workflow uses `google-play` and validates
`WHIP_REVENUECAT_ANDROID_PUBLIC_SDK_KEY` from the protected `google-play`
environment before building. Both release paths require the matching Apple or
Google public SDK key; a Test Store key is rejected by the release validation.

App Store and Google Play builds always show Membership and enable the live
Rancher controller, including purchase, restore, and the existing five-day trial. Cosmetic access
follows actual entitlements or trial eligibility. Developer options are hidden;
saved developer membership overrides, log capture, latency diagnostics, and
terminal visual hints cannot be enabled by old preferences in these builds.

## Development rollout gate for other distribution channels

In GitHub builds and local builds without a store channel, Rancher payments
remain a developer preview. Enabling Developer Options reveals a local **Membership state** selector with Cowboy, Free trial, and
Rancher choices. The selected state controls the membership presentation and
cosmetic capability gates without creating or persisting a RevenueCat
entitlement. Cowboy and Free trial still expose the purchase comparison so its
live store availability and purchase action can be exercised.

While Developer Options is off, Whip does not initialize the Rancher RevenueCat
controller, hides Membership and purchase UI, and grants all cosmetic
capabilities locally. The selected simulator state is retained for the next
developer session but has no effect outside Developer Options. RevenueCat
remains the source of truth once this development rollout gate is removed.
