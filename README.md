# Internal Market Services Section

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

Internal Market Services holds the org's Hive base-layer HIVE:HBD order-book capacity: `derive-peg-ladder-service` is a pure transformation turning a market observation, the account's liquid balance, a risk sleeve, and a ladder policy into a target laddered-bid/laddered-ask book and its diff against resting orders, refusing rather than sizing when the sleeve, spread, or inventory skew forbid it; `apply-peg-ladder-service` is the one effect, signing and broadcasting exactly that diff's `limit_order_create`/`limit_order_cancel` operations through the revived `hive-blockchain-client-service` under an armed mandate record, refusing `mandate-not-armed` and writing a dry-run record otherwise; `reconcile-peg-ladder-fills-service` is a read-only reader of `fill_order` virtual operations since a given block, in the standard fill shape the venue-fill-booking lot consumes; `hive-peg-ladder-cycle-service` composes observe -> derive -> apply -> reconcile for one cycle with a kill switch that cancels the whole ladder on an observer refusal, a haircut move beyond a declared bound, or the account's liquid balance falling below its reserve. Conversions, savings, staking, and delegation are excluded by the founder's 2026-09-04 liquidity ruling: capital in this section stays liquid the whole time.
