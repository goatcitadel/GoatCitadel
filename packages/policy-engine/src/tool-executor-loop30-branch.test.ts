import { describe, expect, it } from "vitest";
import { resolveExecutableCommand, resolveRestrictedCommand } from "./tool-executor.js";

describe("tool executor loop 30 command branch matrix", () => {
  it("passes through non-Windows commands and non-package managers", () => {
    expect(resolveExecutableCommand("node", ["-e", "1"], "linux")).toEqual({ file: "node", args: ["-e", "1"] });
    expect(resolveRestrictedCommand("npm", ["test"], "linux")).toEqual({ file: "npm", args: ["test"] });
  });

  it("wraps Windows package-manager invocations through ComSpec with shell-safe quoting", () => {
    const resolved = resolveExecutableCommand(
      "pnpm",
      ["--filter", "@goatcitadel/policy-engine", "run", "test"],
      "win32",
    );
    expect(resolved.file.toLowerCase()).toContain("cmd");
    expect(resolved.args.slice(0, 4)).toEqual(["/d", "/s", "/v:off", "/c"]);
    expect(resolved.args.at(-1)).toContain("pnpm");
    expect(resolved.args.at(-1)).toContain("@goatcitadel/policy-engine");

    const quoted = resolveExecutableCommand("npm", ["run", "test:coverage", "--", "name with spaces", "a&b"], "win32");
    expect(quoted.args.at(-1)).toContain('^"name^ with^ spaces^"');
    expect(quoted.args.at(-1)).toContain('^"a^&b^"');
  });
});
