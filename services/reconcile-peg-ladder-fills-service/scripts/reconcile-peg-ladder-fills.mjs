#!/usr/bin/env node
import { reconcilePegLadderFills } from "../src/reconcile-peg-ladder-fills.mjs";

export { reconcilePegLadderFills };

if (import.meta.main) {
  if (process.argv.includes("--help")) {
    process.stdout.write(
      "reconcilePegLadderFills — Reads fill_order virtual operations for an account since a given block, cross-checked across two public Hive nodes, in the standard fill shape the venue-fill-booking lot consumes, plus the account's current inventory. Read-only.\n",
    );
  } else {
    process.stdin.setEncoding("utf8");
    let inputText = "";
    for await (const chunk of process.stdin) inputText += chunk;
    for (const line of inputText.split("\n")) {
      if (line.length === 0) continue;
      try {
        process.stdout.write(`${JSON.stringify(await reconcilePegLadderFills(JSON.parse(line)))}\n`);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
    }
  }
}
