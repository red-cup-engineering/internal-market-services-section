#!/usr/bin/env node
import { applyPegLadder } from "../src/apply-peg-ladder.mjs";

export { applyPegLadder };

if (import.meta.main) {
  if (process.argv.includes("--help")) {
    process.stdout.write(
      "applyPegLadder — Signs and broadcasts limit_order_create/limit_order_cancel for a peg-ladder diff under an armed mandate record, refusing mandate-not-armed and writing the diff as a dry-run record otherwise.\n",
    );
  } else {
    process.stdin.setEncoding("utf8");
    let inputText = "";
    for await (const chunk of process.stdin) inputText += chunk;
    for (const line of inputText.split("\n")) {
      if (line.length === 0) continue;
      try {
        process.stdout.write(`${JSON.stringify(await applyPegLadder(JSON.parse(line)))}\n`);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
    }
  }
}
