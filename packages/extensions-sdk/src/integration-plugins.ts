import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { IntegrationPluginAuthorManifest } from "@goatcitadel/contracts";

export type { IntegrationPluginAuthorManifest } from "@goatcitadel/contracts";

export const INTEGRATION_PLUGIN_MANIFEST_FILENAME = "goatcitadel.integration-plugin.json";

export interface ResolvedIntegrationPluginAuthorManifestSource {
  source: string;
  manifest?: IntegrationPluginAuthorManifest;
  manifestPath?: string;
}

export const IntegrationPluginAuthorManifestSchema = z.object({
  pluginId: z.string().min(1),
  label: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1).optional(),
  capabilities: z.array(z.string().min(1)).min(1),
});

export function validateIntegrationPluginAuthorManifest(input: unknown): IntegrationPluginAuthorManifest {
  const manifest = IntegrationPluginAuthorManifestSchema.parse(input);
  return {
    ...manifest,
    capabilities: Array.from(new Set(manifest.capabilities.map((item) => item.trim()).filter(Boolean))),
  } satisfies IntegrationPluginAuthorManifest;
}

export async function loadIntegrationPluginAuthorManifest(
  manifestPath: string,
): Promise<IntegrationPluginAuthorManifest> {
  const absolutePath = path.resolve(manifestPath);
  const raw = await fsPromises.readFile(absolutePath, "utf8");
  return validateIntegrationPluginAuthorManifest(JSON.parse(raw) as unknown);
}

export function resolveIntegrationPluginAuthorManifestSource(
  source: string,
): ResolvedIntegrationPluginAuthorManifestSource {
  const trimmedSource = source.trim();
  if (!trimmedSource) {
    return { source: trimmedSource };
  }

  const resolvedCandidate = path.resolve(trimmedSource);
  if (!fs.existsSync(resolvedCandidate)) {
    return { source: trimmedSource };
  }

  const stats = fs.statSync(resolvedCandidate);
  const manifestPath = stats.isDirectory()
    ? path.join(resolvedCandidate, INTEGRATION_PLUGIN_MANIFEST_FILENAME)
    : resolvedCandidate;
  if (!fs.existsSync(manifestPath)) {
    return { source: resolvedCandidate };
  }

  const raw = fs.readFileSync(manifestPath, "utf8");
  return {
    source: resolvedCandidate,
    manifestPath,
    manifest: validateIntegrationPluginAuthorManifest(JSON.parse(raw) as unknown),
  };
}
