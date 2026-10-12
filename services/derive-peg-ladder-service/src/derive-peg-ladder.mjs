import {
  formatScaled,
  addDecimalStrings,
  multiplyDecimalStrings,
  divideDecimalStrings,
  negateDecimalString as negate,
  compareDecimalStrings as compare,
} from "@red-cup-engineering/computer-data-engineering-services-section/number/decimal-string";

const ASSET_DECIMALS = 3;
const DEFAULT_MIN_RUNG_NOTIONAL_HBD = "0.001";

/** min(a, b) of two plain decimal strings. */
function min(a, b) {
  return compare(a, b) <= 0 ? a : b;
}

/** abs(a) of a plain decimal string. */
function abs(a) {
  return compare(a, "0") < 0 ? negate(a) : a;
}

/** The standard `{orderid,side,priceHbdPerHive}` reference to one resting order, for a diff row. */
export function restingOrderRef(order) {
  return { orderid: order.orderid, side: order.side, priceHbdPerHive: order.priceHbdPerHive };
}

/** Ratio of `numerator` over `denominator`, in basis points, truncated to 6 fractional digits. */
function basisPoints(numerator, denominator) {
  return divideDecimalStrings(multiplyDecimalStrings(numerator, "10000", 30), denominator, 6);
}

/** The anchor price (HBD per HIVE) named by `policy.anchor`, read from the observation. */
function anchorPrice(anchor, observation) {
  if (anchor === "internal-mid") {
    return divideDecimalStrings(addDecimalStrings([observation.bestBid, observation.bestAsk]), "2", 12);
  }
  if (anchor === "external-hbd-in-hive") {
    return divideDecimalStrings(observation.externalPrices.hbdUsd, observation.externalPrices.hiveUsd, 12);
  }
  throw new TypeError(`derive-peg-ladder: request.policy.anchor must be "internal-mid" or "external-hbd-in-hive", got ${JSON.stringify(anchor)}`);
}

/** One rung's price at `sign` (`-1` bid, `+1` ask) `index` spacing-steps from `anchor`. */
function rungPrice(anchor, index, spacingBasisPoints, sign) {
  const offsetFraction = divideDecimalStrings(multiplyDecimalStrings(String(index * spacingBasisPoints), anchor, 18), "10000", 18);
  return sign < 0 ? addDecimalStrings([anchor, negate(offsetFraction)]) : addDecimalStrings([anchor, offsetFraction]);
}

/** A ladder-rung key for matching against a resting order, at fixed 6-decimal price precision. */
function rungKey(side, price) {
  return `${side}:${formatScaled(BigInt(Math.round(Number(price) * 1e6)), 6)}`;
}

/**
 * Derives a target laddered-bid/laddered-ask book for the Hive base-layer HIVE:HBD internal
 * market and its diff against resting orders, sized so a full fill on either side leaves the
 * account able to place the other side (idea 1, 2026-09-04 note "Three Ways to Turn Capital
 * into Capital"). Pure: no network, no signing. Refuses rather than sizing when the sleeve
 * cannot fund one rung per side, the achievable round-trip spread is below the policy minimum,
 * or the account's existing inventory skew exceeds the policy maximum; a refusal's diff cancels
 * every resting order, since a ladder that no longer satisfies policy is never left resting.
 * @param {object} request
 * @param {object} request.observation A HiveInternalMarketObservationRecord (observe-hive-internal-market-service): needs `bestBid`, `bestAsk`, `externalPrices.hiveUsd`, `externalPrices.hbdUsd`.
 * @param {{hive: string, hbd: string}} request.balance The account's current liquid HIVE and HBD balances, as exact decimal strings.
 * @param {{reserveHive: string, reserveHbd: string}} request.sleeve The operating reserve left untouched; only `balance` above this is risked in the ladder.
 * @param {object} request.policy
 * @param {number} request.policy.rungsPerSide Number of ladder rungs per side (>=1).
 * @param {number} request.policy.rungSpacingBasisPoints Basis-point spacing between adjacent rungs and from the anchor to the first rung.
 * @param {"internal-mid"|"external-hbd-in-hive"} request.policy.anchor The internal book's mid price, or the external HBD price expressed in HIVE.
 * @param {number} request.policy.minSpreadCapturedBasisPoints Minimum acceptable round-trip spread (nearest bid to nearest ask), in basis points; the chain's own trading fee is zero.
 * @param {number} request.policy.maxInventorySkewBasisPoints Maximum acceptable |HIVE value in HBD - HBD| / (HIVE value in HBD + HBD), in basis points, before refusal.
 * @param {string} [request.policy.minRungNotionalHbd] Minimum viable per-rung HBD notional (default "0.001"); below this the sleeve cannot fund one rung per side.
 * @param {readonly {orderid: number, side: "bid"|"ask", priceHbdPerHive: string}[]} [request.restingOrders] Currently resting orders to diff against.
 * @param {string} [request.now] An injectable ISO instant for `derivedAt` (default the real current time).
 * @returns {object} A PegLadderDerivationRecord: `{type,version,derivedAt,anchor,sleeveNotionalHbd,ladder,diff,expectedSpreadCapturedBasisPoints,refusal}`.
 * @throws {TypeError} When `request.policy.anchor` names neither supported anchor.
 */
export function derivePegLadder(request) {
  const { observation, balance, sleeve, policy } = request;
  const restingOrders = request.restingOrders ?? [];
  const derivedAt = request.now ? new Date(request.now).toISOString() : new Date().toISOString();
  const anchor = anchorPrice(policy.anchor, observation);
  const anchorRecord = { kind: policy.anchor, priceHbdPerHive: anchor };

  const refuseAll = (reason, detail) => ({
    type: "PegLadderDerivationRecord",
    version: 1,
    derivedAt,
    anchor: anchorRecord,
    sleeveNotionalHbd: null,
    ladder: [],
    diff: { create: [], cancel: restingOrders.map(restingOrderRef), keep: [] },
    expectedSpreadCapturedBasisPoints: null,
    refusal: { reason, ...detail },
  });

  // inventory skew, against the raw declared balance (not the reserve-adjusted sleeve).
  const hiveValueHbd = multiplyDecimalStrings(balance.hive, anchor, 18);
  const totalHbd = addDecimalStrings([hiveValueHbd, balance.hbd]);
  const skewBasisPoints = compare(totalHbd, "0") === 0 ? "0" : basisPoints(abs(addDecimalStrings([hiveValueHbd, negate(balance.hbd)])), totalHbd);
  if (Number(skewBasisPoints) > policy.maxInventorySkewBasisPoints) {
    return refuseAll("inventory-skew-exceeds-maximum", { skewBasisPoints, maxInventorySkewBasisPoints: policy.maxInventorySkewBasisPoints });
  }

  // fundable sleeve, in HBD notional terms, the smaller of the two available sides.
  const availableHive = addDecimalStrings([balance.hive, negate(sleeve.reserveHive)]);
  const availableHbd = addDecimalStrings([balance.hbd, negate(sleeve.reserveHbd)]);
  if (compare(availableHive, "0") <= 0 || compare(availableHbd, "0") <= 0) {
    return refuseAll("sleeve-cannot-fund-one-rung-per-side", { availableHive, availableHbd });
  }
  const availableHiveValueHbd = multiplyDecimalStrings(availableHive, anchor, 18);
  const sleeveNotionalHbd = min(availableHbd, availableHiveValueHbd);
  const perRungNotionalHbd = divideDecimalStrings(sleeveNotionalHbd, String(policy.rungsPerSide), ASSET_DECIMALS);
  const minRungNotionalHbd = policy.minRungNotionalHbd ?? DEFAULT_MIN_RUNG_NOTIONAL_HBD;
  if (compare(perRungNotionalHbd, minRungNotionalHbd) < 0) {
    return refuseAll("sleeve-cannot-fund-one-rung-per-side", { sleeveNotionalHbd, perRungNotionalHbd, minRungNotionalHbd });
  }

  // achievable round-trip spread: nearest bid (rung 1) to nearest ask (rung 1).
  const expectedSpreadCapturedBasisPoints = String(2 * policy.rungSpacingBasisPoints);
  if (Number(expectedSpreadCapturedBasisPoints) < policy.minSpreadCapturedBasisPoints) {
    return refuseAll("spread-below-minimum", { expectedSpreadCapturedBasisPoints, minSpreadCapturedBasisPoints: policy.minSpreadCapturedBasisPoints });
  }

  // orderid is deterministic per rung slot (bid rung i -> i; ask rung i -> 1000+i), so the same
  // slot's resting order can be recognized and repositioned across cycles without a stateful id
  // allocator; rungsPerSide is assumed < 1000.
  const ladder = [];
  for (let rung = 1; rung <= policy.rungsPerSide; rung += 1) {
    const bidPrice = rungPrice(anchor, rung, policy.rungSpacingBasisPoints, -1);
    const bidHive = divideDecimalStrings(perRungNotionalHbd, bidPrice, ASSET_DECIMALS);
    ladder.push({ side: "bid", rung, orderid: rung, priceHbdPerHive: bidPrice, hive: bidHive, hbd: perRungNotionalHbd });

    const askPrice = rungPrice(anchor, rung, policy.rungSpacingBasisPoints, 1);
    const askHive = divideDecimalStrings(perRungNotionalHbd, anchor, ASSET_DECIMALS);
    const askHbd = multiplyDecimalStrings(askHive, askPrice, ASSET_DECIMALS);
    ladder.push({ side: "ask", rung, orderid: 1000 + rung, priceHbdPerHive: askPrice, hive: askHive, hbd: askHbd });
  }

  // Diff by orderid (the rung slot): a resting order in the same slot at the same price is kept;
  // a resting order in a known slot at a stale price is cancelled and its slot's target recreated
  // (a reposition); a resting order in no known slot is cancelled outright.
  const targetsById = new Map(ladder.map((entry) => [entry.orderid, entry]));
  const keep = [];
  const cancel = [];
  for (const order of restingOrders) {
    const target = targetsById.get(order.orderid);
    if (target && rungKey(target.side, target.priceHbdPerHive) === rungKey(order.side, order.priceHbdPerHive)) {
      keep.push(restingOrderRef(order));
      targetsById.delete(order.orderid);
    } else {
      cancel.push(restingOrderRef(order));
    }
  }
  const create = [...targetsById.values()];

  return {
    type: "PegLadderDerivationRecord",
    version: 1,
    derivedAt,
    anchor: anchorRecord,
    sleeveNotionalHbd,
    ladder,
    diff: { create, cancel, keep },
    expectedSpreadCapturedBasisPoints,
    refusal: null,
  };
}
