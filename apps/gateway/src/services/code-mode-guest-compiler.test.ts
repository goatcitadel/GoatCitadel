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
});
