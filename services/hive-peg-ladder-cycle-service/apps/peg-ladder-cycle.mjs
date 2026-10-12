#!/usr/bin/env node
import { readFileText } from "@red-cup-engineering/computer-file-engineering-services-section/read-file";
import { writeFileText } from "@red-cup-engineering/computer-file-engineering-services-section/write-file";
import { HiveClient } from "@red-cup-engineering/hive-blockchain-client-service";
import { observeHiveInternalMarket } from "@red-cup-engineering/observe-hive-internal-market-service";
import { derivePegLadder, restingOrderRef } from "@red-cup-engineering/derive-peg-ladder-service";
import { applyPegLadder } from "@red-cup-engineering/apply-peg-ladder-service";
import { reconcilePegLadderFills } from "@red-cup-engineering/reconcile-peg-ladder-fills-service";
import { put } from "@red-cup-engineering/semiotic-eavt-services-section/store";
import { stripUnitSuffix, compareDecimalStrings } from "@red-cup-engineering/computer-data-engineering-services-section/number/decimal-string";

/** True when decimal string `a` is strictly below decimal string `b`. */
function below(a, b) {
  return compareDecimalStrings(a, b) < 0;
}

/** An open-order entry (`condenser_api.get_open_orders`) to a derive-peg-ladder restingOrders entry. */
function projectOpenOrder(order) {
  const baseSymbol = order.sell_price.base.trim().split(/\s+/u)[1];
  return { orderid: order.orderid, side: baseSymbol === "HBD" ? "bid" : "ask", priceHbdPerHive: order.real_price };
}

/**
 * Runs one Hive peg-ladder cycle: observe the internal market, derive a target ladder against
 * the account's live balance and resting orders, apply the diff under the mandate, and reconcile
 * fills since the last processed block. Cancels every resting order and refuses instead of
 * deriving/applying when the observer refuses, the haircut moves beyond a declared bound, or the
 * account's liquid balance falls below its reserve (the kill switch).
 * @param {object} request
 * @param {string} request.account The Hive account to run the cycle for.
 * @param {object} request.policy A derive-peg-ladder policy, plus `maxHaircutBasisPoints` (the kill-switch haircut bound).
 * @param {{reserveHive: string, reserveHbd: string}} request.sleeve The operating reserve; also the kill-switch balance floor.
 * @param {string} request.mandatePath Absolute path to the mandate JSON file, forwarded to apply-peg-ladder.
 * @param {string} request.journalRoot Filesystem root of the store.
 * @param {string} request.statePath Absolute path to this cycle's own persisted `{lastProcessedBlock}` state.
 * @param {readonly string[]} [request.nodes] Public Hive JSON-RPC node base URLs, forwarded to observe/reconcile and to the live balance/open-orders reads.
 * @param {typeof fetch} [request.fetchImpl] Injectable fetch implementation, for tests.
 * @param {object} [request.fixtures] Literal pre-recorded `observer` (observeHiveInternalMarket fixtures), `accounts`, `openOrders`, and `reconcile` (reconcilePegLadderFills fixtures) results, for deterministic replay.
 * @param {Function} [request.makeReader] Injectable `() => {getAccounts(names),getOpenOrders(account)}` factory, for tests; default constructs a real read-only HiveClient.
 * @param {Function} [request.sign] Injectable signer submission, forwarded to apply-peg-ladder, for tests.
 * @param {string} [request.now] An injectable ISO instant for `ranAt`, for deterministic replay.
 * @returns {Promise<object>} A PegLadderCycleRunRecord: `{type,version,account,ranAt,killSwitch,observation,balance,derivation,applied,reconciliation}`.
 */
export async function runPegLadderCycle(request) {
  const { account, policy, sleeve, mandatePath, journalRoot, statePath } = request;
  const now = request.now ?? new Date().toISOString();
  const nodes = request.nodes;

  const reader = request.makeReader
    ? request.makeReader()
    : (() => {
        const hive = new HiveClient({ nodes });
        return { getAccounts: (names) => hive.getAccounts(names), getOpenOrders: (acct) => hive.getOpenOrders(acct) };
      })();

  const killSwitch = async (reason, detail, observation = null, balance = null) => {
    let restingOrders = [];
    try {
      const openOrders = request.fixtures?.openOrders ?? (await reader.getOpenOrders(account));
      restingOrders = openOrders.map(projectOpenOrder);
    } catch {
      restingOrders = [];
    }
    const diff = { create: [], cancel: restingOrders.map(restingOrderRef), keep: [] };
    const applied = await applyPegLadder({ diff, account, mandatePath, journalRoot, now, sign: request.sign });
    put(journalRoot, "hive-peg-ladder-cycle", { category: "peg-ladder-kill-switch", account, reason, detail, cancelledCount: applied.cancelled.length, refusal: applied.refusal, at: now });
    return { type: "PegLadderCycleRunRecord", version: 1, account, ranAt: now, killSwitch: { reason, detail }, observation, balance, derivation: null, applied, reconciliation: null };
  };

  let observation;
  try {
    observation = request.fixtures?.observer ? await observeHiveInternalMarket({ nodes, now, fixtures: request.fixtures.observer, fetchImpl: request.fetchImpl }) : await observeHiveInternalMarket({ nodes, now, fetchImpl: request.fetchImpl });
  } catch (error) {
    return killSwitch("observer-refused", error instanceof Error ? error.message : String(error));
  }

  if (policy.maxHaircutBasisPoints != null && Math.abs(Number(observation.haircut.vsExternalHbdUsd.basisPoints)) > policy.maxHaircutBasisPoints) {
    return killSwitch("haircut-beyond-bound", { haircutBasisPoints: observation.haircut.vsExternalHbdUsd.basisPoints, maxHaircutBasisPoints: policy.maxHaircutBasisPoints }, observation);
  }

  const [accountRecord] = request.fixtures?.accounts ?? (await reader.getAccounts([account]));
  const balance = { hive: stripUnitSuffix(accountRecord.balance), hbd: stripUnitSuffix(accountRecord.hbd_balance) };

  if (below(balance.hive, sleeve.reserveHive) || below(balance.hbd, sleeve.reserveHbd)) {
    return killSwitch("balance-below-reserve", { balance, reserve: sleeve }, observation, balance);
  }

  const openOrders = request.fixtures?.openOrders ?? (await reader.getOpenOrders(account));
  const restingOrders = openOrders.map(projectOpenOrder);

  const derivation = derivePegLadder({ observation, balance, sleeve, policy, restingOrders, now });
  const applied = await applyPegLadder({ diff: derivation.diff, account, mandatePath, journalRoot, now, sign: request.sign });

  let state = { lastProcessedBlock: 0 };
  try {
    state = JSON.parse(await readFileText(statePath));
  } catch {
    state = { lastProcessedBlock: observation.witnesses[0].headBlockNumber };
  }
  const reconciliation = await reconcilePegLadderFills({
    account,
    sinceBlock: state.lastProcessedBlock,
    nodes,
    now,
    fetchImpl: request.fetchImpl,
    fixtures: request.fixtures?.reconcile,
  });
  await writeFileText(statePath, JSON.stringify({ lastProcessedBlock: reconciliation.lastProcessedBlock }));

  put(journalRoot, "hive-peg-ladder-cycle", { category: "peg-ladder-cycle-result", account, refusal: derivation.refusal, createdCount: applied.created.length, cancelledCount: applied.cancelled.length, fillsCount: reconciliation.fills.length, applyRefusal: applied.refusal, at: now });

  return { type: "PegLadderCycleRunRecord", version: 1, account, ranAt: now, killSwitch: null, observation, balance, derivation, applied, reconciliation };
}

/**
 * `run` subcommand for a systemd oneshot with no interactive stdin: reads the cycle request from
 * the JSON file named by `PEG_LADDER_CYCLE_REQUEST_PATH` (set in the unit's EnvironmentFile) and
 * runs one cycle.
 * @returns {Promise<object>} The same PegLadderCycleRunRecord `runPegLadderCycle` returns.
 * @throws {Error} When `PEG_LADDER_CYCLE_REQUEST_PATH` is unset.
 */
export async function runFromEnvironmentRequestFile() {
  const requestPath = process.env.PEG_LADDER_CYCLE_REQUEST_PATH;
  if (!requestPath) throw new Error("peg-ladder-cycle: PEG_LADDER_CYCLE_REQUEST_PATH is not set");
  const request = JSON.parse(await readFileText(requestPath));
  return runPegLadderCycle(request);
}

if (import.meta.main) {
  if (process.argv.includes("--help")) {
    process.stdout.write(
      "runPegLadderCycle — Runs one Hive peg-ladder cycle (observe -> derive -> apply -> reconcile), cancelling every resting order and refusing instead when the observer refuses, the haircut moves beyond bound, or the account's liquid balance falls below its reserve.\n",
    );
  } else if (process.argv.includes("run")) {
    try {
      process.stdout.write(`${JSON.stringify(await runFromEnvironmentRequestFile())}\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  } else {
    process.stdin.setEncoding("utf8");
    let inputText = "";
    for await (const chunk of process.stdin) inputText += chunk;
    for (const line of inputText.split("\n")) {
      if (line.length === 0) continue;
      try {
        process.stdout.write(`${JSON.stringify(await runPegLadderCycle(JSON.parse(line)))}\n`);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
    }
  }
}
