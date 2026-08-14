import type { SettlementReceipt } from "@agentveins/core";

export async function settleViaFacilitator(_input: unknown): Promise<SettlementReceipt> {
  throw new Error("x402 mode is not implemented yet");
}
