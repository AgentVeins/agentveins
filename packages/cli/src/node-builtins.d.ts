// packages/cli/tsconfig.json sets "types": [] so @types/node's ambient globals never
// type-check, which is what keeps stray console.log out of the library half of this package.
// The CLI writes to stdout deliberately through process.stdout, declared below.
/// <reference path="../../../node_modules/@types/node/fs/promises.d.ts" />
/// <reference path="../../../node_modules/@types/node/crypto.d.ts" />
/// <reference path="../../../node_modules/@types/node/process.d.ts" />
/// <reference path="../../../node_modules/@types/node/readline/promises.d.ts" />
// process.stdout.write, process.stdin.isTTY and Interface.close each live a layer down from the
// modules above: streams, the tty subclass, and readline's base interface respectively.
/// <reference path="../../../node_modules/@types/node/stream.d.ts" />
/// <reference path="../../../node_modules/@types/node/tty.d.ts" />
// tty.WriteStream extends net.Socket, which is where write() actually comes from.
/// <reference path="../../../node_modules/@types/node/net.d.ts" />
/// <reference path="../../../node_modules/@types/node/readline.d.ts" />
/// <reference path="../../../node_modules/@types/node/events.d.ts" />
/// <reference path="../../../node_modules/@types/node/buffer.d.ts" />
/// <reference path="../../../node_modules/@types/node/buffer.buffer.d.ts" />
