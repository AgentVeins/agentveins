// packages/core/tsconfig.json sets "types": [] so @types/node's ambient globals
// (console, process, Buffer, ...) never type-check — that is the enforcement of
// "no console.log in library code". These path references pull in only the
// specific node: module declarations this package's source imports, without
// pulling in the global augmentations that a "types": ["node"] entry would add.
/// <reference path="../../../node_modules/@types/node/url.d.ts" />
/// <reference path="../../../node_modules/@types/node/crypto.d.ts" />
/// <reference path="../../../node_modules/@types/node/fs/promises.d.ts" />
