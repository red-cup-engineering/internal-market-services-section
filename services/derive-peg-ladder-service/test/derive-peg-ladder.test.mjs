import assert from "node:assert/strict";
import test from "node:test";
import { derivePegLadder } from "../src/derive-peg-ladder.mjs";

const observation = {
  type: "HiveInternalMarketObservationRecord",
  version: 1,
  bestBid: "0.04732316",
  bestAsk: "0.04765762",
  externalPrices: { hiveUsd: "0.0469631", hbdUsd: "0.963684" },
};

const basePolicy = {
  rungsPerSide: 3,
  rungSpacingBasisPoints: 50,
  anchor: "internal-mid",
  minSpreadCapturedBasisPoints: 60,
  maxInventorySkewBasisPoints: 8000,
};

test("admits a ladder sized from the reserve-adjusted sleeve, funded on both sides", () => {
  const result = derivePegLadder({
    observation,
    balance: { hive: "115.000", hbd: "5.000" },
    sleeve: { reserveHive: "10.000", reserveHbd: "0.000" },
    policy: basePolicy,
    now: "2026-09-05T00:00:00.000Z",
  });
  assert.equal(result.refusal, null);
  assert.equal(result.ladder.length, 6);
  assert.equal(result.ladder.filter((r) => r.side === "bid").length, 3);
  assert.equal(result.ladder.filter((r) => r.side === "ask").length, 3);
  assert.equal(result.diff.create.length, 6);
  assert.equal(result.diff.cancel.length, 0);
  // bid-side total HBD spend never exceeds the available HBD sleeve.
  const bidHbdTotal = result.ladder.filter((r) => r.side === "bid").reduce((sum, r) => sum + Number(r.hbd), 0);
  assert.ok(bidHbdTotal <= 5.000 + 1e-9);
  // ask-side total HIVE offered never exceeds the available HIVE sleeve.
  const askHiveTotal = result.ladder.filter((r) => r.side === "ask").reduce((sum, r) => sum + Number(r.hive), 0);
  assert.ok(askHiveTotal <= 105.000 + 1e-9);
  // bids sit below the anchor, asks sit above it.
  for (const rung of result.ladder) {
    if (rung.side === "bid") assert.ok(Number(rung.priceHbdPerHive) < Number(result.anchor.priceHbdPerHive));
    else assert.ok(Number(rung.priceHbdPerHive) > Number(result.anchor.priceHbdPerHive));
  }
});

test("refuses sleeve-cannot-fund-one-rung-per-side when balance does not clear the reserve", () => {
  const result = derivePegLadder({
    observation,
    balance: { hive: "5.000", hbd: "0.100" },
    sleeve: { reserveHive: "10.000", reserveHbd: "0.000" },
    policy: basePolicy,
    now: "2026-09-05T00:00:00.000Z",
  });
  assert.equal(result.refusal.reason, "sleeve-cannot-fund-one-rung-per-side");
  assert.equal(result.ladder.length, 0);
});

test("refuses sleeve-cannot-fund-one-rung-per-side when the per-rung notional is dust", () => {
  const result = derivePegLadder({
    observation,
    balance: { hive: "15.000", hbd: "5.0005" },
    sleeve: { reserveHive: "14.999", reserveHbd: "5.000" },
    policy: { ...basePolicy, rungsPerSide: 3 },
    now: "2026-09-05T00:00:00.000Z",
  });
  assert.equal(result.refusal.reason, "sleeve-cannot-fund-one-rung-per-side");
});

test("refuses spread-below-minimum when rung spacing cannot clear the policy floor", () => {
  const result = derivePegLadder({
    observation,
    balance: { hive: "115.000", hbd: "5.000" },
    sleeve: { reserveHive: "10.000", reserveHbd: "0.000" },
    policy: { ...basePolicy, rungSpacingBasisPoints: 10, minSpreadCapturedBasisPoints: 60 },
    now: "2026-09-05T00:00:00.000Z",
  });
  assert.equal(result.refusal.reason, "spread-below-minimum");
});

test("refuses inventory-skew-exceeds-maximum when the account already leans hard to one side", () => {
  const result = derivePegLadder({
    observation,
    balance: { hive: "10000.000", hbd: "0.100" },
    sleeve: { reserveHive: "10.000", reserveHbd: "0.000" },
    policy: { ...basePolicy, maxInventorySkewBasisPoints: 100 },
    now: "2026-09-05T00:00:00.000Z",
  });
  assert.equal(result.refusal.reason, "inventory-skew-exceeds-maximum");
});

test("a refusal's diff cancels every resting order", () => {
  const result = derivePegLadder({
    observation,
    balance: { hive: "5.000", hbd: "0.100" },
    sleeve: { reserveHive: "10.000", reserveHbd: "0.000" },
    policy: basePolicy,
    restingOrders: [{ orderid: 7, side: "bid", priceHbdPerHive: "0.0470" }],
    now: "2026-09-05T00:00:00.000Z",
  });
  assert.equal(result.diff.cancel.length, 1);
  assert.equal(result.diff.cancel[0].orderid, 7);
  assert.equal(result.diff.create.length, 0);
});

test("diff keeps a resting order that matches a target rung price and cancels one that doesn't", () => {
  const first = derivePegLadder({
    observation,
    balance: { hive: "115.000", hbd: "5.000" },
    sleeve: { reserveHive: "10.000", reserveHbd: "0.000" },
    policy: basePolicy,
    now: "2026-09-05T00:00:00.000Z",
  });
  const matchingRung = first.ladder[0];
  const result = derivePegLadder({
    observation,
    balance: { hive: "115.000", hbd: "5.000" },
    sleeve: { reserveHive: "10.000", reserveHbd: "0.000" },
    policy: basePolicy,
    restingOrders: [
      { orderid: 1, side: matchingRung.side, priceHbdPerHive: matchingRung.priceHbdPerHive },
      { orderid: 2, side: "bid", priceHbdPerHive: "0.0001" },
    ],
    now: "2026-09-05T00:00:00.000Z",
  });
  assert.equal(result.diff.keep.length, 1);
  assert.equal(result.diff.keep[0].orderid, 1);
  assert.equal(result.diff.cancel.length, 1);
  assert.equal(result.diff.cancel[0].orderid, 2);
  assert.equal(result.diff.create.length, 5);
});

test("throws TypeError on an unsupported anchor", () => {
  assert.throws(
    () =>
      derivePegLadder({
        observation,
        balance: { hive: "139.980", hbd: "0.418" },
        sleeve: { reserveHive: "10.000", reserveHbd: "0.000" },
        policy: { ...basePolicy, anchor: "nonsense" },
      }),
    TypeError,
  );
});
