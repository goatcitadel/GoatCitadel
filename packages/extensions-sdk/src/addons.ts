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

const LOOPBACK_HEALTH_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const LAUNCH_ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;

/** Mirrors the Gateway launcher's data-only contract; the Gateway re-validates at launch. */
export const AddonLaunchContractSchema = z
  .object({
    command: z.string().min(1).max(256),
    args: z.array(z.string().max(1024)).max(64),
    env: z.record(z.string().regex(LAUNCH_ENV_NAME), z.string().max(4096)).optional(),
    dataFiles: z
      .array(
        z
          .object({
            envVar: z.string().regex(LAUNCH_ENV_NAME),
            fileName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
            companionSuffixes: z
              .array(z.string().regex(/^[A-Za-z0-9._-]{0,32}$/u))
              .max(8)
              .optional(),
          })
          .strict(),
      )
      .max(8)
      .optional(),
    health: z
      .object({
        url: z
          .string()
          .url()
          .refine((value) => {
            const url = new URL(value);
            return url.protocol === "http:" && LOOPBACK_HEALTH_HOSTS.has(url.hostname);
          }, "Add-on health probes must target a loopback http URL."),
        readyWhen: z
          .record(z.union([z.string(), z.number(), z.boolean()]))
          .refine((value) => Object.keys(value).length > 0, "readyWhen needs at least one field."),
        readyTimeoutMs: z.number().int().min(1_000).max(120_000),
      })
      .strict(),
  })
  .strict();

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
  launch: AddonLaunchContractSchema.optional(),
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
