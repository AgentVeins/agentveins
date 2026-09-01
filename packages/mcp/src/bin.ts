#!/usr/bin/env node
import process from "node:process";
import { buildGuard } from "./config.js";
import { serveGuard } from "./serve.js";

// stdout is the protocol. Anything written there that is not MCP framing corrupts the
// session, so every diagnostic goes to stderr.
try {
  const { guard, rail } = await buildGuard(process.env);
  if (rail === "mock") {
    process.stderr.write("agentveins-mcp: mock rail — no money moves, and signatures are not real\n");
  }
  await serveGuard(guard, rail);
  process.stderr.write(`agentveins-mcp: serving pay, check and spend_state on the ${rail} rail\n`);
} catch (error) {
  process.stderr.write(`\nagentveins-mcp refusing to start: ${error instanceof Error ? error.message : String(error)}\n\n`);
  process.exitCode = 1;
}
