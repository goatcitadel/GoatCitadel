import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

describe("shared hashing runtime parity", () => {
  it.each(["native", "browser", "legacy"])("preserves digests and strict hex decoding in %s", (runtime) => {
    // Evaluate the actual source in an isolated realm without process for the
    // browser case. Never replace Vitest's own global process object.
    execFileSync(
      process.execPath,
      [
        "--experimental-vm-modules",
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      import { createHash } from 'node:crypto';
      import { readFileSync } from 'node:fs';
      import { createRequire } from 'node:module';
      import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
      const require = createRequire(${JSON.stringify(fileURLToPath(new URL("./sha256.ts", import.meta.url)))});
      const ts = require('typescript');
      const source = ts.transpileModule(readFileSync(${JSON.stringify(fileURLToPath(new URL("./sha256.ts", import.meta.url)))}, 'utf8'),
        { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
      let nativeCalls = 0;
      const nodeProcess = { getBuiltinModule(name) {
        const builtin = process.getBuiltinModule(name);
        return name === 'crypto' ? { createHash(...args) { nativeCalls++; return builtin.createHash(...args); } } : builtin;
      } };
      const context = createContext({ TextEncoder, Uint8Array,
        ...(${JSON.stringify(runtime)} === 'browser' ? {} : { process: ${JSON.stringify(runtime)} === 'native' ? nodeProcess : {} }) });
      const module = new SourceTextModule(source, { context });
      await module.link((name) => {
        assert.ok(['@noble/hashes/sha256', '@noble/hashes/utils'].includes(name), 'shared code must not statically import Node builtins');
        const exports = require(name);
        return new SyntheticModule(Object.keys(exports), function() {
          for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
        }, { context });
      });
      await module.evaluate();
      const { sha256Hex, sha256BytesHex, hexToBytes } = module.namespace;
      for (const value of ['', 'abc', 'Orion 🐐 7', '\\ud800', '\\udc00', 'a'.repeat(16384)]) {
        assert.equal(sha256Hex(value), createHash('sha256').update(new TextEncoder().encode(value)).digest('hex'));
      }
      const original = Uint8Array.from({length: 4096}, (_, i) => i % 256);
      for (const bytes of [new Uint8Array(), original, original.subarray(17, 201)]) {
        const before = bytes.slice();
        assert.equal(sha256BytesHex(bytes), createHash('sha256').update(bytes).digest('hex'));
        assert.deepEqual(bytes, before);
      }
      const portable = require('@noble/hashes/utils');
      for (const value of ['', 'aBcD00', 'f7'.repeat(512)]) {
        const bytes = hexToBytes(value);
        assert.deepEqual(bytes, portable.hexToBytes(value));
        assert.equal(bytes.constructor, Uint8Array);
        assert.equal(bytes.byteOffset, 0);
        assert.equal(bytes.buffer.byteLength, bytes.byteLength);
        assert.notEqual(bytes.buffer, hexToBytes(value).buffer);
      }
      for (const value of ['a', 'gg', 'aa00zz', '00 1', null, 42]) {
        let expected;
        try { portable.hexToBytes(value); } catch (error) { expected = error.message; }
        assert.throws(() => hexToBytes(value), error => error.message === expected);
      }
      for (const value of [new Uint16Array([1]), null, 42]) assert.throws(() => sha256BytesHex(value));
      assert.equal(nativeCalls > 0, ${JSON.stringify(runtime)} === 'native');
    `,
      ],
      { stdio: "pipe" },
    );
  });
});
