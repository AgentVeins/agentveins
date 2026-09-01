import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Guard } from "@agentveins/core";
import type { Rail } from "./rail.js";
import { toolDefinitions } from "./tools.js";

export const SERVER_NAME = "agentveins";
export const SERVER_VERSION = "0.5.0";

/** Builds the server without connecting it, so tests can drive it over an in-memory pair. */
export function buildServer(guard: Guard, rail: Rail): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  for (const definition of toolDefinitions(guard, rail)) {
    server.registerTool(definition.name, definition.config, definition.handler as never);
  }
  return server;
}

/**
 * Serves a guard over stdio. Reads no environment and no files: an operator with their own
 * guard — a database-backed approval store, a custom adapter — mounts it by calling this.
 */
export async function serveGuard(guard: Guard, rail: Rail): Promise<McpServer> {
  const server = buildServer(guard, rail);
  await server.connect(new StdioServerTransport());
  return server;
}
