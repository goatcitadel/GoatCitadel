import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLUGIN_MANIFEST_FILENAME } from "./plugins.js";
import { isPreflightEntryPoint, runPluginPreflight } from "./plugin-preflight-cli.js";

const REFERENCE_PLUGIN_DIR = fileURLToPath(new URL("../templates/plugins/reference-plugin", import.meta.url));

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-preflight-"));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

async function preflight(args: readonly string[], cwd?: string) {
  const out: string[] = [];
  const err: string[] = [];
  const exitCode = await runPluginPreflight(
    args,
    { out: (line) => out.push(line), err: (line) => err.push(line) },
    cwd,
  );
  return { exitCode, out, err };
}

describe("goatcitadel-plugin-preflight", () => {
  it("prints ok, the plugin id and the manifest hash for the reference plugin, and exits 0", async () => {
    const { exitCode, out, err } = await preflight([REFERENCE_PLUGIN_DIR]);
    expect(exitCode).toBe(0);
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^ok reference-plugin [0-9a-f]{64}$/u);
  });

  it("preflight prints the refusal code for a bad manifest and exits 1", async () => {
    fs.writeFileSync(
      path.join(workDir, PLUGIN_MANIFEST_FILENAME),
      JSON.stringify({
        schemaVersion: 1,
        pluginId: "bad-hook",
        name: "Bad hook",
        description: "A hook that tries to change things.",
        version: "1.0.0",
        pieces: [
          {
            kind: "hook",
            id: "mutator",
            trigger: "tool.call.before",
            url: "https://hooks.example.com/in",
            mode: "mutate",
          },
        ],
      }),
    );
    const { exitCode, out, err } = await preflight([workDir]);
    expect(exitCode).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("HOOK_MUST_ONLY_OBSERVE");
    expect(err.join("\n")).toContain("pieces[0].mode");
  });

  it("prints MANIFEST_MISSING and exits 1 for a folder with no manifest", async () => {
    const { exitCode, err } = await preflight([workDir]);
    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("MANIFEST_MISSING");
  });

  it("reads the current folder when no folder is given", async () => {
    const { exitCode, out } = await preflight([], REFERENCE_PLUGIN_DIR);
    expect(exitCode).toBe(0);
    expect(out[0]).toMatch(/^ok reference-plugin /u);
  });

  it("resolves a relative folder against the working folder", async () => {
    const { exitCode } = await preflight(["reference-plugin"], path.dirname(REFERENCE_PLUGIN_DIR));
    expect(exitCode).toBe(0);
  });

  it("prints usage and exits 1 for an unknown option or too many folders", async () => {
    for (const args of [["--run"], [workDir, workDir]]) {
      const { exitCode, out, err } = await preflight(args);
      expect(exitCode).toBe(1);
      expect(out).toEqual([]);
      expect(err.join("\n")).toContain("Usage: goatcitadel-plugin-preflight");
    }
  });

  it("prints usage and exits 0 for --help", async () => {
    const { exitCode, out } = await preflight(["--help"]);
    expect(exitCode).toBe(0);
    expect(out.join("\n")).toContain("Usage: goatcitadel-plugin-preflight");
  });
});

describe("isPreflightEntryPoint", () => {
  const selfFile = fileURLToPath(new URL("./plugin-preflight-cli.ts", import.meta.url));
  const selfUrl = pathToFileURL(selfFile).href;

  it("is false when nothing started the process from a file", () => {
    expect(isPreflightEntryPoint(undefined, selfUrl)).toBe(false);
    expect(isPreflightEntryPoint("", selfUrl)).toBe(false);
  });

  it("is true for this file and false for another, comparing real paths", () => {
    const realpath = (target: string) => (target === "/bin/preflight-link" ? selfFile : target);
    expect(isPreflightEntryPoint("/bin/preflight-link", selfUrl, realpath)).toBe(true);
    expect(isPreflightEntryPoint(selfFile, selfUrl, realpath)).toBe(true);
    expect(isPreflightEntryPoint("/somewhere/else.js", selfUrl, realpath)).toBe(false);
  });

  it("runs the command when the entry can't be resolved, instead of doing nothing and exiting 0", () => {
    const unresolvable = () => {
      throw new Error("ENOENT");
    };
    expect(isPreflightEntryPoint("/no/such/file", selfUrl, unresolvable)).toBe(true);
  });

  it("runs the command when it is started by its own name without the file extension", () => {
    // `node dist/plugin-preflight-cli` makes Node load the .js file but leaves the extensionless text in argv[1].
    const extensionless = selfFile.replace(/\.ts$/u, "");
    expect(fs.existsSync(extensionless)).toBe(false);
    expect(isPreflightEntryPoint(extensionless, selfUrl)).toBe(true);
  });

  it("is false for a file that exists and is not this one", () => {
    expect(isPreflightEntryPoint(fileURLToPath(new URL("./plugins.ts", import.meta.url)), selfUrl)).toBe(false);
  });
});
