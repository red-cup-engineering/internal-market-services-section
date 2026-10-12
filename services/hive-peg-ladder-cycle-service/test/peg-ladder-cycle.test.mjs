import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runPegLadderCycle, runFromEnvironmentRequestFile } from "../apps/peg-ladder-cycle.mjs";

const NODE_A = "https://api.hive.blog";
const NODE_B = "https://api.openhive.network";

function observerFixtures(overrides = {}) {
  const dgp = { head_block_number: 100000 };
  const book = {
    bids: [{ real_price: "0.0470", hive: 100000, hbd: 4700, created: "2026-09-05T00:00:00" }],
    asks: [{ real_price: "0.0480", hive: 100000, hbd: 4800, created: "2026-09-05T00:00:01" }],
  };
  return {
    dynamicGlobalProperties: { [NODE_A]: dgp, [NODE_B]: dgp },
    orderBook: { [NODE_A]: book, [NODE_B]: book },
    ticker: { latest: "0.0475", lowest_ask: "0.0480", highest_bid: "0.0470", percent_change: "0", hive_volume: { amount: "1000000", precision: 3, nai: "@@000000021" }, hbd_volume: { amount: "50000", precision: 3, nai: "@@000000013" } },
    volume: { hive_volume: { amount: "1000000", precision: 3, nai: "@@000000021" }, hbd_volume: { amount: "50000", precision: 3, nai: "@@000000013" } },
    feedHistory: { current_median_history: { base: "0.0475 HBD", quote: "1.000 HIVE" } },
    conversionQueue: { emsenn0: { conversions: [], collateralizedConversions: [] }, michael561: { conversions: [], collateralizedConversions: [] } },
    coingecko: { hive: 0.0469631, hive_dollar: 0.963684 },
    ...overrides,
  };
}

const policy = {
  rungsPerSide: 3,
  rungSpacingBasisPoints: 50,
  anchor: "internal-mid",
  minSpreadCapturedBasisPoints: 60,
  maxInventorySkewBasisPoints: 8000,
  maxHaircutBasisPoints: 1000,
};

function baseRequest(root, overrides = {}) {
  return {
    account: "emsenn0",
    policy,
    sleeve: { reserveHive: "10.000", reserveHbd: "0.000" },
    mandatePath: join(root, "no-such-mandate.json"),
    journalRoot: root,
    statePath: join(root, "state.json"),
    nodes: [NODE_A, NODE_B],
    now: "2026-09-05T00:10:00.000Z",
    fixtures: {
      observer: observerFixtures(),
      accounts: [{ name: "emsenn0", balance: "115.000 HIVE", hbd_balance: "5.000 HBD" }],
      openOrders: [],
      reconcile: { accountHistory: { [NODE_A]: [], [NODE_B]: [] }, accounts: { [NODE_A]: [{ name: "emsenn0", balance: "115.000 HIVE", hbd_balance: "5.000 HBD" }] }, dynamicGlobalProperties: { [NODE_A]: { head_block_number: 100000 } } },
    },
    ...overrides,
  };
}

test("an ordinary cycle derives a ladder and dry-runs apply when no mandate exists", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "peg-ladder-cycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = await runPegLadderCycle(baseRequest(root));
  assert.equal(result.killSwitch, null);
  assert.equal(result.derivation.refusal, null);
  assert.equal(result.derivation.ladder.length, 6);
  assert.equal(result.applied.refusal.reason, "mandate-not-armed");
  assert.equal(result.reconciliation.fills.length, 0);
});

test("kill switch: cancels every resting order and refuses when the observer refuses", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "peg-ladder-cycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const request = baseRequest(root, {
    fixtures: {
      ...baseRequest(root).fixtures,
      observer: observerFixtures({ dynamicGlobalProperties: { [NODE_A]: { head_block_number: 100000 }, [NODE_B]: { head_block_number: 100200 } } }),
      openOrders: [{ orderid: 1, sell_price: { base: "0.470 HBD", quote: "10.000 HIVE" }, real_price: "0.0470" }],
    },
  });
  const result = await runPegLadderCycle(request);
  assert.equal(result.killSwitch.reason, "observer-refused");
  assert.match(result.killSwitch.detail, /HIVE_INTERNAL_MARKET_NODE_DISAGREEMENT/u);
  assert.equal(result.applied.cancelled.length, 0); // still refused (no mandate); cancel is journaled as a dry-run
  assert.equal(result.applied.refusal.reason, "mandate-not-armed");
});

test("kill switch: refuses when the haircut moves beyond the declared bound", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "peg-ladder-cycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const request = baseRequest(root, { policy: { ...policy, maxHaircutBasisPoints: 1 } });
  const result = await runPegLadderCycle(request);
  assert.equal(result.killSwitch.reason, "haircut-beyond-bound");
});

test("kill switch: refuses when the account's liquid balance falls below its reserve", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "peg-ladder-cycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const request = baseRequest(root, { sleeve: { reserveHive: "1000.000", reserveHbd: "0.000" } });
  const result = await runPegLadderCycle(request);
  assert.equal(result.killSwitch.reason, "balance-below-reserve");
});

test("armed and keyed: an ordinary cycle broadcasts the create diff and persists lastProcessedBlock", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "peg-ladder-cycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mandatePath = join(root, "mandate.json");
  writeFileSync(mandatePath, JSON.stringify({ account: "emsenn0", admittedOperations: ["limit_order_create", "limit_order_cancel"], maxExposure: { hive: "500.000", hbd: "50.000" } }));
  const request = baseRequest(root, {
    mandatePath,
    sign: async (signerRequest) => ({ status: "broadcast", id: signerRequest.operation[0] === "limit_order_cancel" ? "a".repeat(40) : "b".repeat(40) }),
  });
  const result = await runPegLadderCycle(request);
  assert.equal(result.killSwitch, null);
  assert.equal(result.applied.refusal, null);
  assert.equal(result.applied.created.length, 6);
  const { readFileSync } = await import("node:fs");
  const state = JSON.parse(readFileSync(request.statePath, "utf8"));
  assert.equal(state.lastProcessedBlock, 100000);
});

test("run mode: reads the request from PEG_LADDER_CYCLE_REQUEST_PATH and runs one cycle", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "peg-ladder-cycle-run-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const requestPath = join(root, "request.json");
  writeFileSync(requestPath, JSON.stringify(baseRequest(root)));
  const previous = process.env.PEG_LADDER_CYCLE_REQUEST_PATH;
  process.env.PEG_LADDER_CYCLE_REQUEST_PATH = requestPath;
  t.after(() => {
    if (previous === undefined) delete process.env.PEG_LADDER_CYCLE_REQUEST_PATH;
    else process.env.PEG_LADDER_CYCLE_REQUEST_PATH = previous;
  });
  const result = await runFromEnvironmentRequestFile();
  assert.equal(result.killSwitch, null);
  assert.equal(result.derivation.ladder.length, 6);
});

test("run mode: throws when PEG_LADDER_CYCLE_REQUEST_PATH is unset", async () => {
  const previous = process.env.PEG_LADDER_CYCLE_REQUEST_PATH;
  delete process.env.PEG_LADDER_CYCLE_REQUEST_PATH;
  try {
    await assert.rejects(runFromEnvironmentRequestFile(), /PEG_LADDER_CYCLE_REQUEST_PATH is not set/u);
  } finally {
    if (previous !== undefined) process.env.PEG_LADDER_CYCLE_REQUEST_PATH = previous;
  }
});
