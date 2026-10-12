# @red-cup-engineering/reconcile-peg-ladder-fills-service

Reads `fill_order` virtual operations for a Hive account since a given block, cross-checked across two public nodes, in the standard fill shape the venue-fill-booking lot consumes, plus the account's current liquid inventory. Read-only.

## Operation

~~~js
export async function reconcilePegLadderFills(request)
~~~

### Parameters

- request.account The Hive account to read fills for.
- request.sinceBlock Only `fill_order` entries strictly after this block are reported.
- request.nodes Two public Hive JSON-RPC node base URLs to cross-check (default the house pair).
- request.limit `condenser_api.get_account_history` limit per node (default 1000).
- request.fetchImpl Injectable fetch implementation, for tests.
- request.fixtures Literal pre-recorded `accountHistory` (keyed by node), `accounts`, and `dynamicGlobalProperties` (keyed by node; read only when there are no new fills) results, for deterministic replay.
- request.now An injectable ISO instant for `reconciledAt`, for deterministic replay.

### Returns

A `PegLadderFillsReconciliationRecord`: `{type,version,account,sinceBlock,reconciledAt,witnesses,fills,inventory,lastProcessedBlock}`. Each fill is `{venue:"hive-internal-market",account,transactionId,operationId,timestamp,side,baseHive,quoteHbd,fee:"0",witnesses,block}`. `lastProcessedBlock` advances to the primary node's current head block even when there are no new fills, so a quiet cycle never re-scans the same window forever.

### Refusals

- `TypeError`: When `request.nodes` names fewer than two nodes.
- `Error`: `RECONCILE_PEG_LADDER_FILLS_NODE_DISAGREEMENT` when the two nodes' reported fill sets since `sinceBlock` disagree.

## Command

reconcile-peg-ladder-fills reads one JSON value per input line and writes one JSON value per output line.
