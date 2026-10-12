# @red-cup-engineering/apply-peg-ladder-service

Signs and broadcasts a peg-ladder diff's `limit_order_create`/`limit_order_cancel` operations through the revived Hive client (`@red-cup-engineering/hive-blockchain-client-service`), under an armed mandate record naming the account, both operations, and a maximum exposure; refuses `mandate-not-armed` and writes the diff as a dry-run record otherwise. Every broadcast is journaled with its transaction id.

## Operation

~~~js
export async function applyPegLadder(request)
~~~

### Parameters

- request.diff `{create,cancel}` A `PegLadderDerivationRecord` diff (`derive-peg-ladder-service`).
- request.account The Hive account the mandate and orders belong to.
- request.mandatePath Absolute path to the mandate JSON file (`{account, admittedOperations, maxExposure:{hive,hbd}}`), read on this host and never journaled.
- request.activeKeyPath Absolute path to a file holding exactly the account's active WIF, read on this host and never returned or journaled.
- request.journalRoot Filesystem root passed to `createSemanticRecordJournal`.
- request.expirySeconds Limit-order lifetime in seconds before expiration (default 86400).
- request.makeTrader Injectable trader factory, for tests.
- request.now An injectable ISO instant for `appliedAt`, for deterministic replay.

### Returns

An `AppliedPegLadderRecord`: `{type,version,account,appliedAt,created,cancelled,refusal}`.

### Refusals (as data, never a throw)

- `mandate-not-armed` (`detail: "mandate-file-unreadable"`): the mandate file does not exist or cannot be parsed. The diff is journaled as a dry-run record.
- `mandate-not-armed` (`detail: "mandate-insufficient"`): the mandate file exists but does not name this account, admit both `limit_order_create` and `limit_order_cancel`, or declare a `maxExposure`. The diff is journaled as a dry-run record.
- `mandate-not-armed` (`detail: "exceeds-max-exposure"`): the diff's create side would newly lock more HIVE or HBD than `mandate.maxExposure`. The diff is journaled as a dry-run record.
- `no-active-key`: the mandate is armed but `activeKeyPath` cannot be read on this host.

### Throws

- `TypeError` when `request.account` is missing.

## Command

apply-peg-ladder reads one JSON value per input line and writes one JSON value per output line.
