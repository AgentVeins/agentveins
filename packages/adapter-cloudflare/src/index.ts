import { NotImplementedError } from "@agentveins/core";
import type { WalletAdapter } from "@agentveins/core";

export interface CloudflareAdapterConfig {
  walletHandle: string;
}

export function cloudflareAdapter(_config: CloudflareAdapterConfig): WalletAdapter {
  throw new NotImplementedError("Cloudflare Wallets");
}
