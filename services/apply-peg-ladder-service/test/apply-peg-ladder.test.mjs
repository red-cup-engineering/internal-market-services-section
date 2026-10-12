import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyPegLadder } from "../src/apply-peg-ladder.mjs";

const diff = {
  create: [
    { orderid: 1, side: "bid", priceHbdPerHive: "0.0470", hive: "10.000", hbd: "0.470" },
    { orderid: 1001, side: "ask", priceHbdPerHive: "0.0480", hive: "10.000", hbd: "0.480" },
  ],
  cancel: [],
  keep: [],
};

function writeMandate(root, overrides = {}) {
  const path = join(root, "mandate.json");
  writeFileSync(path, JSON.stringify({ account: "emsenn0", admittedOperations: ["limit_order_create", "limit_order_cancel"], maxExposure: { hive: "50.000", hbd: "5.000" }, ...overrides }));
  return path;
}

test("refuses mandate-not-armed and journals a dry-run record when the mandate file is absent", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "apply-peg-ladder-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const record = await applyPegLadder({
    diff,
    account: "emsenn0",
    mandatePath: join(root, "no-such-mandate.json"),
    journalRoot: root,
    now: "2026-09-05T00:00:00.000Z",
  });
  assert.equal(record.refusal.reason, "mandate-not-armed");
  assert.equal(record.refusal.detail, "mandate-file-unreadable");
  assert.equal(record.created.length, 0);
  assert.equal(record.cancelled.length, 0);
});

test("refuses mandate-not-armed when the mandate names a different account", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "apply-peg-ladder-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mandatePath = writeMandate(root, { account: "michael561" });
  const record = await applyPegLadder({
    diff,
    account: "emsenn0",
    mandatePath,
    journalRoot: root,
    now: "2026-09-05T00:00:00.000Z",
  });
  assert.equal(record.refusal.reason, "mandate-not-armed");
  assert.equal(record.refusal.detail, "mandate-insufficient");
});

test("refuses mandate-not-armed when the mandate does not admit both operations", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "apply-peg-ladder-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mandatePath = writeMandate(root, { admittedOperations: ["limit_order_create"] });
  const record = await applyPegLadder({
    diff,
    account: "emsenn0",
    mandatePath,
    journalRoot: root,
    now: "2026-09-05T00:00:00.000Z",
  });
  assert.equal(record.refusal.detail, "mandate-insufficient");
});

test("refuses mandate-not-armed when the diff's create side exceeds the declared max exposure", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "apply-peg-ladder-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mandatePath = writeMandate(root, { maxExposure: { hive: "1.000", hbd: "0.100" } });
  const record = await applyPegLadder({
    diff,
    account: "emsenn0",
    mandatePath,
    journalRoot: root,
    now: "2026-09-05T00:00:00.000Z",
  });
  assert.equal(record.refusal.detail, "exceeds-max-exposure");
});

test("stops at the first rung the signer refuses and reports its refusal", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "apply-peg-ladder-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mandatePath = writeMandate(root);
  const record = await applyPegLadder({
    diff,
    account: "emsenn0",
    mandatePath,
    journalRoot: root,
    now: "2026-09-05T00:00:00.000Z",
    sign: async () => { throw Object.assign(new Error("refused"), { refusal: { status: "refused", datum: "key-unavailable", reason: "no active key is stored for @emsenn0" } }); },
  });
  assert.equal(record.refusal.reason, "key-unavailable");
  assert.equal(record.created.length, 0);
});

test("armed and keyed: broadcasts cancel-then-create through the injected trader and journals each", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "apply-peg-ladder-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mandatePath = writeMandate(root);
  const calls = [];
  const record = await applyPegLadder({
    diff: { create: diff.create, cancel: [{ orderid: 2, side: "bid", priceHbdPerHive: "0.0460" }], keep: [] },
    account: "emsenn0",
    mandatePath,
    journalRoot: root,
    now: "2026-09-05T00:00:00.000Z",
    sign: async (request) => {
      calls.push(request);
      return { status: "broadcast", id: request.operation[0] === "limit_order_cancel" ? "a".repeat(40) : "b".repeat(40) };
    },
  });
  assert.equal(record.refusal, null);
  assert.equal(record.cancelled.length, 1);
  assert.equal(record.cancelled[0].orderid, 2);
  assert.equal(record.created.length, 2);
  assert.equal(record.created[0].transactionId, "b".repeat(40));
  assert.deepEqual(calls.map((request) => [request.lane, request.target, request.operation[0]]), [["peg-ladder", "order:2", "limit_order_cancel"], ["peg-ladder", "order:1", "limit_order_create"], ["peg-ladder", "order:1001", "limit_order_create"]]);
  assert.equal(calls[1].operation[1].expiration, "2026-09-06T00:00:00");
});

test("throws TypeError when account is missing", async () => {
  await assert.rejects(applyPegLadder({ diff, mandatePath: "/nonexistent", journalRoot: "/nonexistent" }), TypeError);
});
