import { NotImplementedError } from "@agentveins/core";
import type { WalletAdapter } from "@agentveins/core";

export interface BaseAdapterConfig {
  rpcUrl: string;
}

export function baseAdapter(_config: BaseAdapterConfig): WalletAdapter {
  throw new NotImplementedError("Base");
}
