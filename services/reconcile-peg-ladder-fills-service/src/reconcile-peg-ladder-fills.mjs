import { RpcClient } from "@red-cup-engineering/hive-blockchain-client-service/rpc.mjs";
import { stripUnitSuffix } from "@red-cup-engineering/computer-data-engineering-services-section/number/decimal-string";

const DEFAULT_NODES = Object.freeze(["https://api.hive.blog", "https://api.openhive.network"]);
const DEFAULT_LIMIT = 1000;

/** `fill_order` account-history entries after `sinceBlock`, keyed by `trx_id:op_in_trx`. */
function fillOrderEntriesSince(history, sinceBlock) {
  const entries = new Map();
  for (const [, entry] of history ?? []) {
    if (entry.op?.[0] !== "fill_order") continue;
    if (entry.block <= sinceBlock) continue;
    entries.set(`${entry.trx_id}:${entry.op_in_trx}`, entry);
  }
  return entries;
}

/** One `fill_order` virtual op, from `account`'s own side, in the standard fill shape. */
function projectFill(entry, account, witnesses) {
  const [, payload] = entry.op;
  const weAreCurrent = payload.current_owner === account;
  const wePay = weAreCurrent ? payload.current_pays : payload.open_pays;
  const weReceive = weAreCurrent ? payload.open_pays : payload.current_pays;
  const paySymbol = wePay.trim().split(/\s+/u)[1];
  const side = paySymbol === "HBD" ? "bid" : "ask"; // paid HBD to buy HIVE == bid; paid HIVE to sell it == ask
  const baseHive = stripUnitSuffix(side === "bid" ? weReceive : wePay);
  const quoteHbd = stripUnitSuffix(side === "bid" ? wePay : weReceive);
  return {
    venue: "hive-internal-market",
    account,
    transactionId: entry.trx_id,
    operationId: `${entry.trx_id}:${entry.op_in_trx}`,
    timestamp: `${entry.timestamp}Z`,
    side,
    baseHive,
    quoteHbd,
    fee: "0",
    witnesses,
    block: entry.block,
  };
}

/**
 * Reads `fill_order` virtual operations for `account` since `sinceBlock`, cross-checked across
 * two public Hive nodes, and reports them in the standard fill shape the venue-fill-booking lot
 * consumes, plus the account's current liquid inventory. Read-only.
 * @param {object} request
 * @param {string} request.account The Hive account to read fills for.
 * @param {number} request.sinceBlock Only `fill_order` entries strictly after this block are reported.
 * @param {readonly string[]} [request.nodes] Two public Hive JSON-RPC node base URLs to cross-check (default the house pair).
 * @param {number} [request.limit] `condenser_api.get_account_history` limit per node (default 1000).
 * @param {typeof fetch} [request.fetchImpl] Injectable fetch implementation, for tests.
 * @param {object} [request.fixtures] Literal pre-recorded `accountHistory` (keyed by node), `accounts`, and `dynamicGlobalProperties` (keyed by node; read only when there are no new fills) results, for deterministic replay.
 * @param {string} [request.now] An injectable ISO instant for `reconciledAt`, for deterministic replay.
 * @returns {Promise<object>} A PegLadderFillsReconciliationRecord: `{type,version,account,sinceBlock,reconciledAt,witnesses,fills,inventory,lastProcessedBlock}`.
 * @throws {TypeError} When `request.nodes` names fewer than two nodes.
 * @throws {Error} `RECONCILE_PEG_LADDER_FILLS_NODE_DISAGREEMENT` when the two nodes' reported fill sets since `sinceBlock` disagree.
 */
export async function reconcilePegLadderFills(request) {
  const { account, sinceBlock } = request;
  const nodes = request.nodes ?? DEFAULT_NODES;
  if (!Array.isArray(nodes) || nodes.length < 2) throw new TypeError("reconcile-peg-ladder-fills: request.nodes must name at least two nodes");
  const limit = request.limit ?? DEFAULT_LIMIT;
  const fetchImpl = request.fetchImpl ?? fetch;
  const fixtures = request.fixtures;
  const [primary, secondary] = nodes;
  const reconciledAt = request.now ? new Date(request.now).toISOString() : new Date().toISOString();

  const [primaryHistory, secondaryHistory] = await Promise.all([
    fixtures?.accountHistory?.[primary] ?? new RpcClient({ nodes: [primary], fetch: fetchImpl }).call("condenser_api.get_account_history", [account, -1, limit]),
    fixtures?.accountHistory?.[secondary] ?? new RpcClient({ nodes: [secondary], fetch: fetchImpl }).call("condenser_api.get_account_history", [account, -1, limit]),
  ]);

  const primaryFills = fillOrderEntriesSince(primaryHistory, sinceBlock);
  const secondaryFills = fillOrderEntriesSince(secondaryHistory, sinceBlock);
  const missingFromSecondary = [...primaryFills.keys()].filter((key) => !secondaryFills.has(key));
  const missingFromPrimary = [...secondaryFills.keys()].filter((key) => !primaryFills.has(key));
  if (missingFromSecondary.length > 0 || missingFromPrimary.length > 0) {
    throw new Error(
      `RECONCILE_PEG_LADDER_FILLS_NODE_DISAGREEMENT: ${primary} and ${secondary} disagree on fill_order entries since block ${sinceBlock} (missingFromSecondary=${JSON.stringify(missingFromSecondary)}, missingFromPrimary=${JSON.stringify(missingFromPrimary)})`,
    );
  }

  const witnesses = [{ node: primary }, { node: secondary }];
  const fills = [...primaryFills.values()]
    .sort((a, b) => a.block - b.block || a.op_in_trx - b.op_in_trx)
    .map((entry) => projectFill(entry, account, witnesses));

  // When there are no new fills, the cursor still advances to the primary node's current head
  // block (never stays pinned at sinceBlock), so a quiet cycle does not re-scan the same window
  // forever as the chain moves on.
  const headBlockNumber = fixtures?.dynamicGlobalProperties?.[primary]?.head_block_number
    ?? (await new RpcClient({ nodes: [primary], fetch: fetchImpl }).call("condenser_api.get_dynamic_global_properties", [])).head_block_number;
  const lastProcessedBlock = fills.length === 0 ? Math.max(sinceBlock, headBlockNumber) : Math.max(...fills.map((fill) => fill.block));

  const [account_] = fixtures?.accounts?.[primary] ?? (await new RpcClient({ nodes: [primary], fetch: fetchImpl }).call("condenser_api.get_accounts", [[account]]));
  const inventory = {
    hive: stripUnitSuffix(account_.balance),
    hbd: stripUnitSuffix(account_.hbd_balance),
  };

  return { type: "PegLadderFillsReconciliationRecord", version: 1, account, sinceBlock, reconciledAt, witnesses, fills, inventory, lastProcessedBlock };
}
