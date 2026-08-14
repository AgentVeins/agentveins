import type { SettlementReceipt, SettlementRequest, WalletAdapter } from "@agentveins/core";

export function mockAdapter(): WalletAdapter {
  let counter = 0;
  return {
    name: "solana",
    currency: "USDC",
    async execute(req: SettlementRequest): Promise<SettlementReceipt> {
      counter++;
      return { txSig: `mock-${counter}-${req.amountMinor}`, rail: "solana-mock" };
    },
  };
}
