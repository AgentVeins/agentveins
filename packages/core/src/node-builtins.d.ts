// packages/core/tsconfig.json sets "types": [] so @types/node's ambient globals
// (console, process, Buffer, ...) never type-check — that is the enforcement of
// "no console.log in library code". These path references pull in only the
// specific node: module declarations this package's source imports, without
// pulling in the global augmentations that a "types": ["node"] entry would add.
/// <reference path="../../../node_modules/@types/node/url.d.ts" />
/// <reference path="../../../node_modules/@types/node/crypto.d.ts" />
/// <reference path="../../../node_modules/@types/node/fs/promises.d.ts" />
/// <reference path="../../../node_modules/@types/node/buffer.d.ts" />
/// <reference path="../../../node_modules/@types/node/buffer.buffer.d.ts" />
/// <reference path="../../../node_modules/@types/node/os.d.ts" />
/// <reference path="../../../node_modules/@types/node/path.d.ts" />
// node:fs/promises's readFile/writeFile overloads take an `Abortable` from node:events;
// without this, that type resolves to `any` and TS silently picks the Buffer-returning
// overload instead of the string one for calls like readFile(path, "utf8").
/// <reference path="../../../node_modules/@types/node/events.d.ts" />
