#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import process from "node:process";
import { parseArgs } from "./args.js";
import { run } from "./run.js";

const io = {
  out(text: string): void {
    process.stdout.write(text);
  },
  async ask(question: string): Promise<string | null> {
    // A pipe or a CI job has nobody to answer, and a prompt read from a closed stdin would
    // return "" and read as a decline. Saying so beats silently granting nothing.
    if (!process.stdin.isTTY) {
      return null;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
  now(): Date {
    return new Date();
  },
};

try {
  process.exitCode = await run(parseArgs(process.argv.slice(2)), io);
} catch (error) {
  process.stderr.write(`\n  ${error instanceof Error ? error.message : String(error)}\n\n`);
  process.exitCode = 1;
}
