#!/usr/bin/env node
import { derivePegLadder } from "../src/derive-peg-ladder.mjs";

export { derivePegLadder };

if (import.meta.main) {
  if (process.argv.includes("--help")) {
    process.stdout.write(
      "derivePegLadder — Derives a target laddered-bid/laddered-ask book for the Hive base-layer HIVE:HBD internal market and its diff against resting orders, refusing rather than sizing when the sleeve, spread, or inventory skew forbid it.\n",
    );
  } else {
    process.stdin.setEncoding("utf8");
    let inputText = "";
    for await (const chunk of process.stdin) inputText += chunk;
    for (const line of inputText.split("\n")) {
      if (line.length === 0) continue;
      try {
        process.stdout.write(`${JSON.stringify(derivePegLadder(JSON.parse(line)))}\n`);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
    }
  }
}
