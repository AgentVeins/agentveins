// @types/node declares the global `CryptoKey` but not `CryptoKeyPair`: WebCrypto treats the
// pair as a dictionary rather than a constructible global, so only lib.dom declares it. This
// package targets Node, and @solana/kit's signer helpers take a bare `CryptoKeyPair`, so
// declare the one missing global here instead of pulling all of lib.dom into the build.
interface CryptoKeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}
