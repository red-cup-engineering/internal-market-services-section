import assert from "node:assert/strict";
import test from "node:test";
import { reconcilePegLadderFills } from "../src/reconcile-peg-ladder-fills.mjs";

const NODE_A = "https://api.hive.blog";
const NODE_B = "https://api.openhive.network";

const bidFill = [
  1,
  {
    trx_id: "a".repeat(40),
    block: 100010,
    trx_in_block: 0,
    op_in_trx: 0,
    virtual_op: 1,
    timestamp: "2026-09-05T00:00:10",
    op: ["fill_order", { current_owner: "emsenn0", current_orderid: 1, current_pays: "1.000 HBD", open_owner: "someoneelse", open_orderid: 5, open_pays: "20.000 HIVE" }],
  },
];

const askFill = [
  2,
  {
    trx_id: "b".repeat(40),
    block: 100020,
    trx_in_block: 0,
    op_in_trx: 0,
    virtual_op: 1,
    timestamp: "2026-09-05T00:01:20",
    op: ["fill_order", { current_owner: "someoneelse", current_orderid: 6, current_pays: "0.250 HBD", open_owner: "emsenn0", open_orderid: 1001, open_pays: "5.000 HIVE" }],
  },
];

const staleFill = [
  0,
  {
    trx_id: "c".repeat(40),
    block: 99000,
    trx_in_block: 0,
    op_in_trx: 0,
    virtual_op: 1,
    timestamp: "2026-09-04T00:00:00",
    op: ["fill_order", { current_owner: "emsenn0", current_orderid: 1, current_pays: "1.000 HBD", open_owner: "someoneelse", open_orderid: 5, open_pays: "20.000 HIVE" }],
  },
];

const notAFill = [
  3,
  { trx_id: "d".repeat(40), block: 100015, trx_in_block: 0, op_in_trx: 0, virtual_op: 0, timestamp: "2026-09-05T00:00:30", op: ["transfer", { from: "emsenn0", to: "someoneelse", amount: "1.000 HIVE", memo: "" }] },
];

function accountsFixture() {
  return { [NODE_A]: [{ name: "emsenn0", balance: "139.980 HIVE", hbd_balance: "0.418 HBD" }] };
}

test("reports bid and ask fills since a block in the standard fill shape, and current inventory", async () => {
  const history = [staleFill, bidFill, notAFill, askFill];
  const result = await reconcilePegLadderFills({
    account: "emsenn0",
    sinceBlock: 100000,
    nodes: [NODE_A, NODE_B],
    now: "2026-09-05T00:10:00.000Z",
    fixtures: { accountHistory: { [NODE_A]: history, [NODE_B]: history }, accounts: accountsFixture() },
  });
  assert.equal(result.fills.length, 2);
  const bid = result.fills.find((f) => f.side === "bid");
  assert.equal(bid.venue, "hive-internal-market");
  assert.equal(bid.transactionId, "a".repeat(40));
  assert.equal(bid.baseHive, "20.000");
  assert.equal(bid.quoteHbd, "1.000");
  assert.equal(bid.fee, "0");
  const ask = result.fills.find((f) => f.side === "ask");
  assert.equal(ask.baseHive, "5.000");
  assert.equal(ask.quoteHbd, "0.250");
  assert.equal(result.inventory.hive, "139.980");
  assert.equal(result.inventory.hbd, "0.418");
  assert.equal(result.lastProcessedBlock, 100020);
  assert.equal(result.witnesses.length, 2);
});

test("excludes fills at or before sinceBlock and non-fill_order ops", async () => {
  const history = [staleFill, bidFill, notAFill];
  const result = await reconcilePegLadderFills({
    account: "emsenn0",
    sinceBlock: 100000,
    nodes: [NODE_A, NODE_B],
    fixtures: { accountHistory: { [NODE_A]: history, [NODE_B]: history }, accounts: accountsFixture() },
  });
  assert.equal(result.fills.length, 1);
  assert.equal(result.fills[0].transactionId, "a".repeat(40));
});

test("advances lastProcessedBlock to the current head block when there are no new fills", async () => {
  const history = [staleFill];
  const result = await reconcilePegLadderFills({
    account: "emsenn0",
    sinceBlock: 100000,
    nodes: [NODE_A, NODE_B],
    fixtures: { accountHistory: { [NODE_A]: history, [NODE_B]: history }, accounts: accountsFixture(), dynamicGlobalProperties: { [NODE_A]: { head_block_number: 100050 } } },
  });
  assert.equal(result.fills.length, 0);
  assert.equal(result.lastProcessedBlock, 100050);
});

test("throws RECONCILE_PEG_LADDER_FILLS_NODE_DISAGREEMENT when the two nodes' fill sets disagree", async () => {
  await assert.rejects(
    reconcilePegLadderFills({
      account: "emsenn0",
      sinceBlock: 100000,
      nodes: [NODE_A, NODE_B],
      fixtures: { accountHistory: { [NODE_A]: [bidFill], [NODE_B]: [] }, accounts: accountsFixture() },
    }),
    /RECONCILE_PEG_LADDER_FILLS_NODE_DISAGREEMENT/u,
  );
});

test("throws TypeError when fewer than two nodes are named", async () => {
  await assert.rejects(reconcilePegLadderFills({ account: "emsenn0", sinceBlock: 0, nodes: [NODE_A] }), TypeError);
});
