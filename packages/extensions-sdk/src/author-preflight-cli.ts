#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  preflightIntegrationPluginAuthorManifest,
  resolveIntegrationPluginAuthorManifestSource,
} from "./integration-plugins.js";

export function inspectAuthorManifestSource(source: string, configuredKeys: readonly string[] = []) {
  if (!source.trim() || configuredKeys.some((key) => !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(key)))
    throw new Error("Provide a local manifest source and configuration key names only.");
  const resolved = resolveIntegrationPluginAuthorManifestSource(source);
  if (!resolved.manifest)
    return {
      ok: false as const,
      issues: resolved.manifestIssues ?? [
        {
          code: "manifest.unavailable",
          severity: "critical" as const,
          message: "A valid local integration-plugin manifest could not be read.",
          action: "Check the local path, JSON syntax and descriptor size, then rerun preflight.",
        },
      ],
    };
  return preflightIntegrationPluginAuthorManifest(resolved.manifest, configuredKeys);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [source, ...flags] = process.argv.slice(2);
    if (!source || flags.some((flag) => !flag.startsWith("--configured-key=")))
      throw new Error("Usage: goatcitadel-extension-preflight LOCAL_SOURCE [--configured-key=NAME]");
    const result = inspectAuthorManifestSource(
      source,
      flags.map((flag) => flag.slice("--configured-key=".length)),
    );
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exitCode = result.ok ? 0 : 1;
  } catch {
    process.stderr.write(
      "Author preflight failed. Use a readable local manifest and --configured-key=NAME arguments; do not pass configuration values.\n",
    );
    process.exitCode = 1;
  }
}
