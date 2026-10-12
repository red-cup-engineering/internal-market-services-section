# @red-cup-engineering/hive-peg-ladder-cycle-service

Composes `observe-hive-internal-market`, `derive-peg-ladder`, `apply-peg-ladder`, and `reconcile-peg-ladder-fills` into one Hive internal-market peg-ladder cycle, with a kill switch that cancels every resting order and refuses instead of deriving/applying when the observer refuses, the haircut moves beyond a declared bound, or the account's liquid balance falls below its reserve.

## Operation

~~~js
export async function runPegLadderCycle(request)
~~~

### Parameters

- request.account The Hive account to run the cycle for.
- request.policy A derive-peg-ladder policy, plus `maxHaircutBasisPoints` (the kill-switch haircut bound).
- request.sleeve `{reserveHive, reserveHbd}` the operating reserve; also the kill-switch balance floor.
- request.mandatePath Absolute path to the mandate JSON file, forwarded to apply-peg-ladder.
- request.activeKeyPath Absolute path to the account's active WIF file, forwarded to apply-peg-ladder.
- request.journalRoot Filesystem root passed to `createSemanticRecordJournal`.
- request.statePath Absolute path to this cycle's own persisted `{lastProcessedBlock}` state.
- request.nodes Public Hive JSON-RPC node base URLs.
- request.fetchImpl Injectable fetch implementation, for tests.
- request.fixtures Literal pre-recorded results, for deterministic replay.
- request.makeReader Injectable read-only account/open-orders factory, for tests.
- request.makeTrader Injectable trader factory, forwarded to apply-peg-ladder, for tests.
- request.now An injectable ISO instant for `ranAt`, for deterministic replay.

### Returns

A `PegLadderCycleRunRecord`: `{type,version,account,ranAt,killSwitch,observation,balance,derivation,applied,reconciliation}`. `killSwitch` is `null` on an ordinary cycle, or `{reason,detail}` (`"observer-refused"` | `"haircut-beyond-bound"` | `"balance-below-reserve"`) when the ladder was cancelled outright instead of derived/applied.

## Command

peg-ladder-cycle reads one JSON value per input line and writes one JSON value per output line. `peg-ladder-cycle run` (no stdin) instead reads its request from the JSON file named by the `PEG_LADDER_CYCLE_REQUEST_PATH` environment variable and runs exactly one cycle — the shape a systemd oneshot's `EnvironmentFile` and `ExecStart` need, with no interactive stdin.

## Deployment

Runs as `hive-peg-ladder-cycle.service` on a `systemd --user` timer (every 5 minutes) on cold-red-gate, `ExecStart=... apps/peg-ladder-cycle.mjs run` with `EnvironmentFile=` setting `PEG_LADDER_CYCLE_REQUEST_PATH`. It runs dry (`applied.refusal.reason === "mandate-not-armed"`) until `~/.config/561-group/hive-internal-market-mandate.json` names the account and both limit-order operations as admitted with a maximum exposure.
