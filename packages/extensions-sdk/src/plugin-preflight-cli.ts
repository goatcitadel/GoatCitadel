#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPluginManifest } from "./plugins.js";

export interface PluginPreflightOutput {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = [
  "Usage: goatcitadel-plugin-preflight [PLUGIN_FOLDER]",
  "",
  "Checks the goatcitadel-plugin.json in PLUGIN_FOLDER (the current folder by default).",
  "It only reads that one file. It prints 'ok <pluginId> <manifestSha256>' and exits 0, or prints the refusal and exits 1.",
];

/** The command's whole behaviour, apart from process wiring. Returns the exit code. */
export async function runPluginPreflight(
  args: readonly string[],
  output: PluginPreflightOutput,
  cwd: string = process.cwd(),
): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    for (const line of USAGE) output.out(line);
    return 0;
  }
  if (args.length > 1 || args[0]?.startsWith("-")) {
    for (const line of USAGE) output.err(line);
    return 1;
  }

  const result = await loadPluginManifest(path.resolve(cwd, args[0] ?? "."));
  if (result.ok) {
    output.out(`ok ${result.manifest.pluginId} ${result.manifestSha256}`);
    return 0;
  }
  output.err(`${result.code}: ${result.message}`);
  if (result.field) output.err(`  at ${result.field}`);
  return 1;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    // A package manager can start the command through a link, so compare real paths.
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  try {
    process.exitCode = await runPluginPreflight(process.argv.slice(2), {
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    });
  } catch (error) {
    process.stderr.write(`Plugin preflight failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  }
}
