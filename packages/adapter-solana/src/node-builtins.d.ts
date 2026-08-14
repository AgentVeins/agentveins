// packages/adapter-solana/tsconfig.json sets "types": [] so @types/node is not auto-included.
// These path references pull in only the specific node: module declarations this package
// imports. Note that "types": [] does NOT keep node's ambient globals out here: undici-types,
// bundled by @solana/rpc-transport-http and reachable from @solana/kit, carries a
// `/// <reference types="node" />` that loads all of @types/node regardless. test/no-console.test.ts
// enforces the no-console rule instead, since the compiler cannot.
/// <reference path="../../../node_modules/@types/node/crypto.d.ts" />
/// <reference path="../../../node_modules/@types/node/timers/promises.d.ts" />
/// <reference path="../../../node_modules/@types/node/fs/promises.d.ts" />
/// <reference path="../../../node_modules/@types/node/buffer.d.ts" />
/// <reference path="../../../node_modules/@types/node/buffer.buffer.d.ts" />
/// <reference path="../../../node_modules/@types/node/events.d.ts" />
