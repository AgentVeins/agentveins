// packages/core/src/node-builtins.d.ts intentionally omits os/path — they are
// dead for the src build. The test suite imports node:os and node:path
// (temp-directory helpers for the audit sink and anchor tests), so this file
// declares just those two modules for the test-only type-check.
/// <reference path="../../../node_modules/@types/node/os.d.ts" />
/// <reference path="../../../node_modules/@types/node/path.d.ts" />
