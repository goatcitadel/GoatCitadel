import { describe, expect, it } from "vitest";
import { validateGuestSource } from "./code-mode-guest-compiler.js";

describe("Code Mode guest source validation", () => {
  it.each([
    ['const unused = globalThis["fetch"];', "fetch"],
    ["const unused = globalThis[`process`];", "process"],
    ['const toolkit = {}; toolkit["setTimeout"]();', "timers or schedulers"],
  ])("rejects a reserved static member in %s", async (source, label) => {
    await expect(validateGuestSource("javascript", source)).rejects.toThrow(
      `Code Mode source may not reference ${label}.`,
    );
  });

  it("allows ordinary static member reads and calls", async () => {
    await expect(
      validateGuestSource(
        "javascript",
        'const values = { fetch: 1, read: () => 2 }; values["fetch"] + values[`read`]();',
      ),
    ).resolves.toBeUndefined();
  });

  it("parses generic arrow functions using TypeScript syntax", async () => {
    await expect(
      validateGuestSource("typescript", "const identity = <T>(value: T) => value; identity(1);"),
    ).resolves.toBeUndefined();
  });

  it("allows ordinary object property names in TypeScript signatures", async () => {
    await expect(
      validateGuestSource("typescript", "const values: { fetch: number } = { fetch: 1 }; values.fetch;"),
    ).resolves.toBeUndefined();
  });

  it("allows ordinary method names in TypeScript signatures", async () => {
    await expect(
      validateGuestSource("typescript", "const values: { fetch(): number } = { fetch: () => 1 };"),
    ).resolves.toBeUndefined();
  });

  it.each([
    'const { "fetch": reference } = globalThis;',
    'const { [("fetch")]: reference } = (globalThis);',
    "function use({ [`fetch`]: reference } = globalThis) {}",
  ])("rejects reserved global properties in object bindings", async (source) => {
    await expect(validateGuestSource("javascript", source)).rejects.toThrow(
      "Code Mode source may not reference fetch.",
    );
  });

  it("allows ordinary object bindings with the same property name", async () => {
    await expect(
      validateGuestSource("javascript", "const values = { fetch: 1 }; const { fetch: value } = values;"),
    ).resolves.toBeUndefined();
  });

  it("rejects TypeScript annotations in JavaScript source", async () => {
    await expect(validateGuestSource("javascript", "const value: number = 1;")).rejects.toThrow(
      /^Code Mode source could not be parsed:/,
    );
  });

  it.each(['export * from "fixture-module";', 'export { value } from "fixture-module";'])(
    "rejects source dependencies declared by a re-export",
    async (source) => {
      await expect(validateGuestSource("typescript", source)).rejects.toThrow("module re-exports");
    },
  );

  it.each([
    ["javascript", 'const unused = (globalThis)[("fetch")];'],
    ["typescript", 'const unused = (globalThis as unknown)!["fetch"];'],
    ["typescript", 'const unused = (<unknown>globalThis)["fetch"];'],
    ["typescript", 'const unused = (globalThis satisfies unknown)["fetch"];'],
  ] as const)("recognizes reserved globals through transparent %s syntax", async (language, source) => {
    await expect(validateGuestSource(language, source)).rejects.toThrow("Code Mode source may not reference fetch.");
  });
});
