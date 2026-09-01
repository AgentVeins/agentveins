/** Which settlement path the server was configured for. Its own module so the protocol layer
 *  can name it without importing the configuration layer, and the Solana stack behind it. */
export type Rail = "solana" | "mock";
