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

/**
 * Whether this module was started as the command, as opposed to imported by something else.
 *
 * A package manager can start the command through a link, so real paths are compared. If the entry can't be resolved,
 * this answers true: the likeliest cause is `node dist/plugin-preflight-cli` without the extension, which Node loads
 * but leaves unresolvable in argv[1], and answering false there would exit 0 having checked nothing.
 */
export function isPreflightEntryPoint(
  entry: string | undefined,
  moduleUrl: string,
  realpath: (target: string) => string = realpathSync,
): boolean {
  if (!entry) return false;
  try {
    return realpath(entry) === realpath(fileURLToPath(moduleUrl));
  } catch {
    return true;
  }
}

if (isPreflightEntryPoint(process.argv[1], import.meta.url)) {
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
