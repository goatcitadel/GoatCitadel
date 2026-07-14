import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { IntegrationPluginAuthorManifest, PluginDescriptorHealthIssue } from "@goatcitadel/contracts";

export type { IntegrationPluginAuthorManifest } from "@goatcitadel/contracts";

export const INTEGRATION_PLUGIN_MANIFEST_FILENAME = "goatcitadel.integration-plugin.json";
export const INTEGRATION_PLUGIN_MANIFEST_MAX_BYTES = 256 * 1024;

export interface ResolvedIntegrationPluginAuthorManifestSource {
  source: string;
  manifest?: IntegrationPluginAuthorManifest;
  manifestPath?: string;
  manifestIssues?: PluginDescriptorHealthIssue[];
  manifestError?: string;
  descriptorHash?: string;
}

export const IntegrationPluginAuthorManifestSchema = z.object({
  pluginId: z.string().min(1),
  label: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1).optional(),
  capabilities: z.array(z.string().min(1)).min(1),
  packageName: z.string().min(1).optional(),
  integrity: z
    .object({
      expected: z.string().min(1).optional(),
    })
    .optional(),
  theme: z
    .object({
      accentColor: z.string().min(1).optional(),
      icon: z.string().min(1).optional(),
      dashboardVariant: z.enum(["default", "compact", "high_contrast"]).optional(),
    })
    .optional(),
  toolOverrides: z
    .array(
      z.object({
        toolName: z.string().min(1),
        override: z.boolean(),
      }),
    )
    .optional(),
});

export function validateIntegrationPluginAuthorManifest(input: unknown): IntegrationPluginAuthorManifest {
  const manifest = IntegrationPluginAuthorManifestSchema.parse(input);
  return {
    ...manifest,
    capabilities: Array.from(new Set(manifest.capabilities.map((item) => item.trim()).filter(Boolean))),
    toolOverrides: manifest.toolOverrides?.map((entry) => ({ ...entry, toolName: entry.toolName.trim() })),
  } satisfies IntegrationPluginAuthorManifest;
}

export type IntegrationPluginAuthorManifestValidationResult =
  | {
      ok: true;
      manifest: IntegrationPluginAuthorManifest;
      descriptorHash: string;
      issues: [];
    }
  | {
      ok: false;
      issues: PluginDescriptorHealthIssue[];
    };

export function validateIntegrationPluginAuthorManifestDetailed(
  input: unknown,
): IntegrationPluginAuthorManifestValidationResult {
  const parsed = IntegrationPluginAuthorManifestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        code: `manifest.${issue.code}`,
        severity: "critical",
        message: `${issue.path.join(".") || "manifest"}: ${issue.message}`,
        action: "Fix goatcitadel.integration-plugin.json and reinstall or repair the plugin.",
      })),
    };
  }
  const manifest = validateIntegrationPluginAuthorManifest(parsed.data);
  return {
    ok: true,
    manifest,
    descriptorHash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    issues: [],
  };
}

export async function loadIntegrationPluginAuthorManifest(
  manifestPath: string,
): Promise<IntegrationPluginAuthorManifest> {
  const absolutePath = path.resolve(manifestPath);
  const raw = await readIntegrationPluginManifest(absolutePath);
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

  let parsed: unknown;
  try {
    const raw = readIntegrationPluginManifestSync(manifestPath);
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    return {
      source: resolvedCandidate,
      manifestPath,
      manifestError: error instanceof Error ? error.message : String(error),
    };
  }
  const detailed = validateIntegrationPluginAuthorManifestDetailed(parsed);
  if (!detailed.ok) {
    return {
      source: resolvedCandidate,
      manifestPath,
      manifestIssues: detailed.issues,
    };
  }
  return {
    source: resolvedCandidate,
    manifestPath,
    manifest: detailed.manifest,
    descriptorHash: detailed.descriptorHash,
  };
}

async function readIntegrationPluginManifest(manifestPath: string): Promise<string> {
  const handle = await fsPromises.open(manifestPath, "r");
  try {
    const stats = await handle.stat();
    assertIntegrationPluginManifestFile(stats, manifestPath);
    const buffer = Buffer.alloc(INTEGRATION_PLUGIN_MANIFEST_MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) {
        break;
      }
      bytesRead += result.bytesRead;
    }
    assertIntegrationPluginManifestByteCount(bytesRead, manifestPath);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

function readIntegrationPluginManifestSync(manifestPath: string): string {
  const descriptor = fs.openSync(manifestPath, "r");
  try {
    const stats = fs.fstatSync(descriptor);
    assertIntegrationPluginManifestFile(stats, manifestPath);
    const buffer = Buffer.alloc(INTEGRATION_PLUGIN_MANIFEST_MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunkBytes = fs.readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunkBytes === 0) {
        break;
      }
      bytesRead += chunkBytes;
    }
    assertIntegrationPluginManifestByteCount(bytesRead, manifestPath);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertIntegrationPluginManifestFile(stats: Pick<fs.Stats, "isFile" | "size">, manifestPath: string): void {
  if (!stats.isFile()) {
    throw new Error(`Integration plugin descriptor must be a regular file: ${manifestPath}`);
  }
  if (stats.size > INTEGRATION_PLUGIN_MANIFEST_MAX_BYTES) {
    throw new Error(
      `Integration plugin descriptor exceeds the ${INTEGRATION_PLUGIN_MANIFEST_MAX_BYTES}-byte limit: ${manifestPath}`,
    );
  }
}

function assertIntegrationPluginManifestByteCount(bytesRead: number, manifestPath: string): void {
  if (bytesRead > INTEGRATION_PLUGIN_MANIFEST_MAX_BYTES) {
    throw new Error(
      `Integration plugin descriptor exceeds the ${INTEGRATION_PLUGIN_MANIFEST_MAX_BYTES}-byte limit: ${manifestPath}`,
    );
  }
}
