import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildWindowsCommand,
  clampOption,
  isPromptCancellation,
  parseCommaSeparated,
  providerKeyMissing,
  quoteWindowsCommandArg,
  redactSecret,
  resolvePnpmCommandForPlatform,
  safeHostnameFromUrl,
  validateHttpUrl,
  validateRequired,
} from "./onboarding-tui-helpers.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeAppDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-onboarding-helpers-"));
  tempDirs.push(root);
  return path.join(root, "app");
}

describe("onboarding TUI helpers", () => {
  it("resolves bundled pnpm commands before falling back to platform defaults", async () => {
    const appDir = await makeAppDir();
    const baseDir = path.dirname(appDir);
    await fs.mkdir(path.join(baseDir, "bin"), { recursive: true });

    expect(resolvePnpmCommandForPlatform(appDir, "linux")).toEqual({
      cmd: "pnpm",
      prefix: [],
    });

    const linuxPnpm = path.join(baseDir, "bin", "pnpm");
    await fs.writeFile(linuxPnpm, "", "utf8");
    expect(resolvePnpmCommandForPlatform(appDir, "linux")).toEqual({
      cmd: linuxPnpm,
      prefix: [],
    });

    const windowsAppDir = await makeAppDir();
    expect(resolvePnpmCommandForPlatform(windowsAppDir, "win32")).toEqual({
      cmd: "pnpm.cmd",
      prefix: [],
    });
    const windowsBaseDir = path.dirname(windowsAppDir);
    await fs.mkdir(path.join(windowsBaseDir, "bin"), { recursive: true });
    const pnpmPs1 = path.join(windowsBaseDir, "bin", "pnpm.ps1");
    await fs.writeFile(pnpmPs1, "", "utf8");
    expect(resolvePnpmCommandForPlatform(windowsAppDir, "win32")).toEqual({
      cmd: "powershell.exe",
      prefix: ["-ExecutionPolicy", "Bypass", "-File", pnpmPs1],
    });

    const pnpmCmd = path.join(windowsBaseDir, "bin", "pnpm.cmd");
    await fs.writeFile(pnpmCmd, "", "utf8");
    expect(resolvePnpmCommandForPlatform(windowsAppDir, "win32")).toEqual({
      cmd: pnpmCmd,
      prefix: [],
    });
  }, 15_000);

  it("keeps Windows command quoting and simple onboarding parsing deterministic", () => {
    expect(quoteWindowsCommandArg("")).toBe('""');
    expect(quoteWindowsCommandArg("simple")).toBe("simple");
    expect(quoteWindowsCommandArg("C:\\Program Files\\pnpm.cmd")).toBe('"C:\\Program Files\\pnpm.cmd"');
    expect(buildWindowsCommand(["pnpm.cmd", "--dir", "C:\\Goat Citadel", "dev:gateway"])).toBe(
      'pnpm.cmd --dir "C:\\Goat Citadel" dev:gateway',
    );
    expect(() => quoteWindowsCommandArg('value"quoted')).toThrow(/embedded quotes/);
    expect(() => quoteWindowsCommandArg("%PATH%")).toThrow(/percent expansions/);
    expect(() => quoteWindowsCommandArg("line\nbreak")).toThrow(/control characters/);

    expect(clampOption("power", ["saver", "balanced", "power"] as const, "balanced")).toBe("power");
    expect(clampOption("turbo", ["saver", "balanced", "power"] as const, "balanced")).toBe("balanced");
    expect(parseCommaSeparated(" 127.0.0.1, , localhost,api.example.test ")).toEqual([
      "127.0.0.1",
      "localhost",
      "api.example.test",
    ]);
    expect(safeHostnameFromUrl("https://api.example.test/v1")).toBe("api.example.test");
    expect(safeHostnameFromUrl("not a url")).toBeUndefined();
  });

  it("recognises a closed prompt and validates answers (U-FR-008, U-FR-009)", () => {
    expect(
      isPromptCancellation(
        Object.assign(new Error("User force closed the prompt with SIGINT"), { name: "ExitPromptError" }),
      ),
    ).toBe(true);
    expect(isPromptCancellation(new Error("boom"))).toBe(false);
    expect(isPromptCancellation("ExitPromptError")).toBe(false);
    expect(validateHttpUrl("http://127.0.0.1:9")).toBe(true);
    expect(validateHttpUrl("https://api.example.com/v1")).toBe(true);
    const urlMessage = "Enter a full address that starts with http:// or https://.";
    expect(validateHttpUrl("")).toBe(urlMessage);
    expect(validateHttpUrl("127.0.0.1:8787")).toBe(urlMessage);
    expect(validateHttpUrl("ftp://example.com")).toBe(urlMessage);
    expect(validateRequired("a model id")("  ")).toBe("Enter a model id.");
    expect(validateRequired("a model id")("glm-5")).toBe(true);
  });

  it("says a provider key is missing only when nothing supplies it", () => {
    expect(providerKeyMissing({ apiKey: "", apiKeyEnv: "GLM_API_KEY", env: {} })).toBe(true);
    expect(providerKeyMissing({ apiKey: "", apiKeyEnv: "GLM_API_KEY", env: { GLM_API_KEY: "  " } })).toBe(true);
    expect(providerKeyMissing({ apiKey: "", apiKeyEnv: "GLM_API_KEY", env: { GLM_API_KEY: "k" } })).toBe(false);
    expect(providerKeyMissing({ apiKey: "typed", apiKeyEnv: "GLM_API_KEY", env: {} })).toBe(false);
    expect(providerKeyMissing({ apiKey: "", apiKeyEnv: "", env: {} })).toBe(false);
  });

  it("hides a secret that appears in a message", () => {
    expect(redactSecret("failed for sk-abc123 twice: sk-abc123", "sk-abc123")).toBe(
      "failed for [hidden] twice: [hidden]",
    );
    expect(redactSecret("nothing to hide", "")).toBe("nothing to hide");
  });
});
