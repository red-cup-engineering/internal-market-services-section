# @red-cup-engineering/derive-peg-ladder-service

Pure transformation deriving a target laddered-bid/laddered-ask book for the Hive base-layer HIVE:HBD internal market from a market observation, the account's liquid balance, a risk sleeve, and a ladder policy, plus the diff against resting orders; refuses rather than sizing when the sleeve cannot fund one rung per side, the spread is below the minimum, or inventory skew exceeds the maximum.

## Operation

~~~js
export function derivePegLadder(request)
~~~

### Parameters

- request.observation A `HiveInternalMarketObservationRecord` (`@red-cup-engineering/observe-hive-internal-market-service`): needs `bestBid`, `bestAsk`, `externalPrices.hiveUsd`, `externalPrices.hbdUsd`.
- request.balance `{hive, hbd}` the account's current liquid balances, as exact decimal strings.
- request.sleeve `{reserveHive, reserveHbd}` the operating reserve left untouched; only `balance` above this is risked in the ladder.
- request.policy `{rungsPerSide, rungSpacingBasisPoints, anchor, minSpreadCapturedBasisPoints, maxInventorySkewBasisPoints, minRungNotionalHbd?}`.
- request.restingOrders Currently resting orders (`{orderid, side, priceHbdPerHive}`) to diff against.
- request.now An injectable ISO instant, for deterministic replay.

### Returns

A `PegLadderDerivationRecord`: `{type,version,derivedAt,anchor,sleeveNotionalHbd,ladder,diff,expectedSpreadCapturedBasisPoints,refusal}`. `diff` is `{create,cancel,keep}`. A refusal's `diff.cancel` names every resting order — a ladder that no longer satisfies policy is never left resting.

### Refusals (as data, never a throw)

- `sleeve-cannot-fund-one-rung-per-side`: the reserve-adjusted balance is non-positive on either side, or the per-rung HBD notional is below `minRungNotionalHbd`.
- `spread-below-minimum`: the achievable round-trip spread (`2 * rungSpacingBasisPoints`) is below `minSpreadCapturedBasisPoints`.
- `inventory-skew-exceeds-maximum`: the account's existing HIVE-value-vs-HBD skew exceeds `maxInventorySkewBasisPoints`.

### Throws

- `TypeError` when `request.policy.anchor` names neither `"internal-mid"` nor `"external-hbd-in-hive"`.

## Command

derive-peg-ladder reads one JSON value per input line and writes one JSON value per output line.
