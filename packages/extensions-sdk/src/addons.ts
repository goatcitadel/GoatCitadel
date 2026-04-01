import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AddonAuthorManifest } from "@goatcitadel/contracts";

export type { AddonAuthorManifest } from "@goatcitadel/contracts";

export const ADDON_MANIFEST_FILENAME = "goatcitadel.addon.json";

export const AddonInstallCommandSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string().min(1)).optional(),
  note: z.string().min(1).optional(),
});

export const AddonHealthCheckRecordSchema = z.object({
  key: z.string().min(1),
  status: z.enum(["pass", "warn", "fail"]),
  message: z.string().min(1),
});

export const AddonCatalogEntrySchema = z.object({
  addonId: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  owner: z.string().min(1),
  repoUrl: z.string().url(),
  sameOwnerAsGoatCitadel: z.boolean(),
  trustTier: z.enum(["trusted", "restricted", "community"]),
  category: z.enum(["fun_optional", "productivity", "other"]),
  runtimeType: z.literal("separate_repo_app"),
  installCommands: z.array(AddonInstallCommandSchema).min(1),
  webEntryMode: z.enum(["none", "external_local_url", "embedded_proxy"]),
  requiresSeparateRepoDownload: z.literal(true),
  launchUrl: z.string().url().optional(),
  healthChecks: z.array(AddonHealthCheckRecordSchema).min(1),
});

export const AddonAuthorManifestSchema = z.object({
  schemaVersion: z.literal(1),
  addon: AddonCatalogEntrySchema,
  authorNotes: z.string().min(1).optional(),
});

export function validateAddonAuthorManifest(input: unknown): AddonAuthorManifest {
  return AddonAuthorManifestSchema.parse(input) satisfies AddonAuthorManifest;
}

export async function loadAddonAuthorManifest(manifestPath: string): Promise<AddonAuthorManifest> {
  const absolutePath = path.resolve(manifestPath);
  const raw = await fs.readFile(absolutePath, "utf8");
  return validateAddonAuthorManifest(JSON.parse(raw) as unknown);
}
