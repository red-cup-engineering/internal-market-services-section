import { readFileText } from "@red-cup-engineering/computer-file-engineering-services-section/read-file";
import { limitOrderCancel, limitOrderCreate } from "@red-cup-engineering/hive-blockchain-client-service/ops.mjs";
import { submitToSigner } from "@red-cup-engineering/hive-fleet-operations-service/signer";
import { put } from "@red-cup-engineering/semiotic-eavt-services-section/store";
import { addDecimalStrings, compareDecimalStrings } from "@red-cup-engineering/computer-data-engineering-services-section/number/decimal-string";

const REQUIRED_ADMITTED_OPERATIONS = Object.freeze(["limit_order_create", "limit_order_cancel"]);
const DEFAULT_EXPIRY_SECONDS = 86400;

/** True when decimal string `a` exceeds decimal string `b`. */
function exceeds(a, b) {
  return compareDecimalStrings(a, b) > 0;
}

/** Whether `mandate` names `account` and admits both limit-order operations with a declared exposure cap. */
function mandateArmed(mandate, account) {
  return (
    mandate != null &&
    mandate.account === account &&
    Array.isArray(mandate.admittedOperations) &&
    REQUIRED_ADMITTED_OPERATIONS.every((op) => mandate.admittedOperations.includes(op)) &&
    mandate.maxExposure != null &&
    typeof mandate.maxExposure.hive === "string" &&
    typeof mandate.maxExposure.hbd === "string"
  );
}

/** Total HIVE and HBD the create side of a diff would newly lock. */
function createExposure(create) {
  const hive = create.length === 0 ? "0" : addDecimalStrings(create.filter((o) => o.side === "ask").map((o) => o.hive).concat(["0"]));
  const hbd = create.length === 0 ? "0" : addDecimalStrings(create.filter((o) => o.side === "bid").map((o) => o.hbd).concat(["0"]));
  return { hive, hbd };
}

/** The `[amount_to_sell, min_to_receive]` asset pair for one ladder-diff entry. */
function orderAssets(entry) {
  return entry.side === "bid"
    ? { amount_to_sell: `${entry.hbd} HBD`, min_to_receive: `${entry.hive} HIVE` }
    : { amount_to_sell: `${entry.hive} HIVE`, min_to_receive: `${entry.hbd} HBD` };
}

/**
 * Applies a peg-ladder diff: hands each `limit_order_create`/`limit_order_cancel` to the Hive fleet
 * signer (its peg-ladder lane re-checks the mandate and holds the key), under an armed mandate record naming the account, both
 * operations, and a maximum exposure, refusing `mandate-not-armed` and writing the diff as a
 * dry-run record otherwise. Every broadcast is journaled with its transaction id.
 * @param {object} request
 * @param {{create: readonly object[], cancel: readonly object[]}} request.diff A PegLadderDerivationRecord diff (derive-peg-ladder-service).
 * @param {string} request.account The Hive account the mandate and orders belong to.
 * @param {string} request.mandatePath Absolute path to the mandate JSON file (`{account, admittedOperations, maxExposure:{hive,hbd}}`), read on this host and never journaled.
 * @param {string} request.journalRoot Filesystem root of the store.
 * @param {number} [request.expirySeconds] Limit-order lifetime in seconds before expiration (default 86400); the cycle reprices and rebroadcasts well within this.
 * @param {Function} [request.sign] Injectable signer submission (request) => Promise<{id}>, for tests; default the fleet signer.
 * @param {string} [request.now] An injectable ISO instant for `appliedAt`, for deterministic replay.
 * @returns {Promise<object>} An AppliedPegLadderRecord: `{type,version,account,appliedAt,created,cancelled,refusal}`.
 * @throws {TypeError} When `request.account` is missing.
 */
export async function applyPegLadder(request) {
  const { diff, account, mandatePath, journalRoot } = request;
  if (!account) throw new TypeError("apply-peg-ladder: request.account is required");
  const appliedAt = request.now ? new Date(request.now).toISOString() : new Date().toISOString();
  const expirySeconds = request.expirySeconds ?? DEFAULT_EXPIRY_SECONDS;

  const refuseDryRun = (detail, mandate = null) => {
    put(journalRoot, "hive-peg-ladder-apply", { category: "peg-ladder-dry-run", account, diff, detail, at: appliedAt });
    return { type: "AppliedPegLadderRecord", version: 1, account, appliedAt, created: [], cancelled: [], refusal: { reason: "mandate-not-armed", detail, mandatePath } };
  };

  let mandate = null;
  try {
    mandate = JSON.parse(await readFileText(mandatePath));
  } catch {
    return refuseDryRun("mandate-file-unreadable");
  }
  if (!mandateArmed(mandate, account)) return refuseDryRun("mandate-insufficient");

  const exposure = createExposure(diff.create);
  if (exceeds(exposure.hive, mandate.maxExposure.hive) || exceeds(exposure.hbd, mandate.maxExposure.hbd)) {
    return refuseDryRun("exceeds-max-exposure");
  }

  const sign = request.sign ?? submitToSigner;
  const rung = (orderid, operation) => sign({ account, role: "active", lane: "peg-ladder", target: `order:${orderid}`, mandate, operation });

  const cancelled = [];
  const created = [];
  // The signer refusing a rung stops the ladder there; what already went out stays recorded.
  const refusedBySigner = (error) => {
    if (!error?.refusal) throw error;
    return { type: "AppliedPegLadderRecord", version: 1, account, appliedAt, created, cancelled, refusal: { reason: error.refusal.datum, detail: error.refusal.reason } };
  };
  for (const entry of diff.cancel) {
    let result;
    try { result = await rung(entry.orderid, limitOrderCancel({ owner: account, orderid: entry.orderid })); } catch (error) { return refusedBySigner(error); }
    cancelled.push({ orderid: entry.orderid, transactionId: result.id });
    put(journalRoot, "hive-peg-ladder-apply", { category: "peg-ladder-cancel", account, orderid: entry.orderid, side: entry.side, priceHbdPerHive: entry.priceHbdPerHive, transactionId: result.id, at: new Date().toISOString() });
  }

  // Chain expiration: ISO seconds, UTC, no zone suffix.
  const expiration = new Date(new Date(appliedAt).getTime() + expirySeconds * 1000).toISOString().slice(0, 19);
  for (const entry of diff.create) {
    const { amount_to_sell, min_to_receive } = orderAssets(entry);
    let result;
    try { result = await rung(entry.orderid, limitOrderCreate({ owner: account, orderid: entry.orderid, amount_to_sell, min_to_receive, fill_or_kill: false, expiration })); } catch (error) { return refusedBySigner(error); }
    created.push({ orderid: entry.orderid, side: entry.side, priceHbdPerHive: entry.priceHbdPerHive, transactionId: result.id });
    put(journalRoot, "hive-peg-ladder-apply", { category: "peg-ladder-create", account, orderid: entry.orderid, side: entry.side, priceHbdPerHive: entry.priceHbdPerHive, hive: entry.hive, hbd: entry.hbd, expiration, transactionId: result.id, at: new Date().toISOString() });
  }

  return { type: "AppliedPegLadderRecord", version: 1, account, appliedAt, created, cancelled, refusal: null };
}
