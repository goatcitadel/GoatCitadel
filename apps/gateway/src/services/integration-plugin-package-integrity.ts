import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ValidationError,
  type IntegrationPluginInstallSourceType,
  type IntegrationPluginTrustWarning,
} from "@goatcitadel/contracts";
import { fetchAllowlistedOnce } from "@goatcitadel/policy-engine";
import { readBoundedResponseBytes, readBoundedResponseJson } from "./bounded-response-reader.js";

export const DEFAULT_NPM_REGISTRY_URL = "https://registry.npmjs.org";
export const PLUGIN_TARBALL_MAX_BYTES = 32 * 1024 * 1024;
export const LOCAL_MANIFEST_LIMITS = { maxFiles: 5_000, maxTotalBytes: 64 * 1024 * 1024 } as const;

const METADATA_MAX_BYTES = 1024 * 1024;
const NETWORK_TIMEOUT_MS = 60_000;
const MAX_DEPTH = 24;
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git"]);
const EXPECTED_INTEGRITY_MESSAGE =
  "expectedIntegrity must be a single sha512-<base64> (npm) or sha256-<base64> (local manifest) value";

export type PluginPackageIntegrityResult =
  | {
      status: "verified";
      actualIntegrity: string;
      integritySource: "operator" | "registry" | "manifest";
      verifiedAt: string;
      artifactPath?: string;
      warnings: IntegrationPluginTrustWarning[];
    }
  | {
      status: "quarantined";
      actualIntegrity?: string;
      expectedIntegrity: string;
      warnings: IntegrationPluginTrustWarning[];
    }
  | { status: "not_applicable"; actualIntegrity?: string; warnings: IntegrationPluginTrustWarning[] }
  | { status: "unknown"; warnings: IntegrationPluginTrustWarning[] };

export interface VerifyIntegrationPluginPackageInput {
  pluginId: string;
  source: string;
  sourceType: IntegrationPluginInstallSourceType;
  expectedIntegrity?: string;
  networkAllowlist: readonly string[];
  /** `<rootDir>/<dataDir>/integration-plugins`. */
  pluginStoreRoot: string;
  fetchOnce?: typeof fetchAllowlistedOnce;
  now?: () => Date;
}

const DIGEST_BYTES = { sha512: 64, sha256: 32 } as const;

export function parseNpmPackageSpec(source: string): { name: string; version?: string } | undefined {
  const spec = source.trim().replace(/^npm:/u, "");
  if (!spec) return undefined;
  const at = spec.lastIndexOf("@");
  const name = at > 0 ? spec.slice(0, at) : spec;
  const version = at > 0 ? spec.slice(at + 1) : undefined;
  if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u.test(name)) return undefined;
  if (version !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(version)) return undefined;
  return version === undefined ? { name } : { name, version };
}

export function parseSriIntegrity(value: string): { algorithm: "sha512" | "sha256"; digest: string } | undefined {
  const match = /^(sha512|sha256)-([A-Za-z0-9+/]+={0,2})$/u.exec(value);
  if (!match) return undefined;
  const algorithm = match[1] as "sha512" | "sha256";
  const digest = match[2]!;
  const bytes = Buffer.from(digest, "base64");
  if (bytes.length !== DIGEST_BYTES[algorithm] || bytes.toString("base64") !== digest) return undefined;
  return { algorithm, digest };
}

export async function computeLocalPluginManifestIntegrity(root: string): Promise<string> {
  const base = path.resolve(root);
  const rootStat = await lstat(base);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Plugin manifest root must be an ordinary directory.");
  }
  const entries: Array<[string, number, string]> = [];
  let total = 0;
  const visit = async (relative: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) throw new Error("Plugin manifest directory depth exceeds the limit.");
    for (const item of await readdir(path.join(base, relative))) {
      const name = relative ? `${relative}/${item}` : item;
      const filename = path.join(base, name);
      const stat = await lstat(filename);
      if (stat.isSymbolicLink()) throw new Error("Plugin manifest contains a symlink.");
      if (stat.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(item)) continue;
        await visit(name, depth + 1);
        continue;
      }
      if (!stat.isFile()) throw new Error("Plugin manifest contains an unsupported filesystem entry.");
      if (stat.nlink > 1) throw new Error("Plugin manifest contains a hardlinked file.");
      total += stat.size;
      if (entries.length >= LOCAL_MANIFEST_LIMITS.maxFiles || total > LOCAL_MANIFEST_LIMITS.maxTotalBytes) {
        throw new Error("Plugin manifest exceeds the file or byte limit.");
      }
      entries.push([name, stat.size, await hashFile(filename, stat)]);
    }
  };
  await visit("", 0);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return `sha256-${createHash("sha256").update(JSON.stringify(entries)).digest("base64")}`;
}

async function hashFile(filename: string, expected: { ino: number; dev: number; size: number }): Promise<string> {
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const held = await handle.stat();
    if (!held.isFile() || held.size !== expected.size || (expected.ino !== 0 && held.ino !== expected.ino)) {
      throw new Error("Plugin manifest file changed during verification.");
    }
    const bytes = Buffer.alloc(held.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error("Plugin manifest file size changed during verification.");
      offset += bytesRead;
    }
    return createHash("sha256").update(bytes).digest("hex");
  } finally {
    await handle.close();
  }
}

function warning(
  code: string,
  severity: IntegrationPluginTrustWarning["severity"],
  message: string,
): IntegrationPluginTrustWarning {
  return { code, severity, message };
}

const MISMATCH = warning(
  "integrity_mismatch",
  "critical",
  "Plugin package bytes do not match the expected integrity. The package was not stored.",
);
function unverifiable(reason: string): IntegrationPluginTrustWarning {
  return warning(
    "integrity_unverifiable",
    "critical",
    `Plugin package integrity could not be verified (registry fetch blocked or failed: ${reason}). Add the registry host to the network allowlist and reinstall.`,
  );
}

/** A short, non-secret cause code for a failed registry request. */
class RegistryReason extends Error {}

function registryFailureReason(error: unknown): string {
  if (error instanceof RegistryReason) return error.message;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  if (name === "TimeoutError" || name === "AbortError") return "registry_timeout";
  if (/allowlist|not allowed|blocked/iu.test(message)) return "registry_blocked";
  if (/exceed|limit|too large/iu.test(message)) return "registry_response_limit";
  return "registry_fetch_failed";
}

function manifestFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/symlink/iu.test(message)) return "manifest_symlink";
  if (/hardlink/iu.test(message)) return "manifest_hardlink";
  if (/limit|depth/iu.test(message)) return "manifest_limit";
  if (/changed during/iu.test(message)) return "manifest_changed";
  if (/unsupported/iu.test(message)) return "manifest_unsupported_entry";
  return "manifest_unreadable";
}

const SAFE_PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function assertSafePluginId(pluginId: string): void {
  if (!SAFE_PLUGIN_ID.test(pluginId) || pluginId.includes("..")) {
    throw new ValidationError({ field: "pluginId", message: "pluginId is not a safe plugin store directory name" });
  }
}

export async function verifyIntegrationPluginPackage(
  input: VerifyIntegrationPluginPackageInput,
): Promise<PluginPackageIntegrityResult> {
  if (input.sourceType === "npm") assertSafePluginId(input.pluginId);
  const now = input.now ?? (() => new Date());
  const expected = input.expectedIntegrity?.trim() || undefined;
  if (expected !== undefined) {
    const wanted = input.sourceType === "npm" ? "sha512" : input.sourceType === "local" ? "sha256" : undefined;
    const parsed = parseSriIntegrity(expected);
    if (!parsed || (wanted && parsed.algorithm !== wanted))
      throw new ValidationError({ field: "expectedIntegrity", message: EXPECTED_INTEGRITY_MESSAGE });
  }
  if (input.sourceType === "npm") return verifyNpm(input, expected, now);
  if (input.sourceType === "local") return verifyLocal(input, expected, now);
  return {
    status: "unknown",
    warnings: [
      warning("integrity_not_verified", "warning", "Integrity is not verified for git, URL or manual plugin sources."),
    ],
  };
}

async function verifyLocal(
  input: VerifyIntegrationPluginPackageInput,
  expected: string | undefined,
  now: () => Date,
): Promise<PluginPackageIntegrityResult> {
  let actual: string;
  try {
    actual = await computeLocalPluginManifestIntegrity(path.resolve(input.source));
  } catch (error) {
    return {
      status: "quarantined",
      expectedIntegrity: expected ?? "",
      warnings: [
        warning(
          "integrity_manifest_invalid",
          "critical",
          `The local plugin tree could not be hashed (${manifestFailureReason(error)}): symlink, hardlink, unsupported entry, or size limit.`,
        ),
      ],
    };
  }
  if (expected === undefined) return { status: "not_applicable", actualIntegrity: actual, warnings: [] };
  if (actual !== expected) {
    return { status: "quarantined", actualIntegrity: actual, expectedIntegrity: expected, warnings: [MISMATCH] };
  }
  return {
    status: "verified",
    actualIntegrity: actual,
    integritySource: "operator",
    verifiedAt: now().toISOString(),
    warnings: [],
  };
}

async function verifyNpm(
  input: VerifyIntegrationPluginPackageInput,
  expected: string | undefined,
  now: () => Date,
): Promise<PluginPackageIntegrityResult> {
  const spec = parseNpmPackageSpec(input.source);
  if (!spec) {
    return {
      status: "unknown",
      warnings: [warning("integrity_registry_invalid", "critical", "The npm package specifier is not valid.")],
    };
  }
  const fetchOnce = input.fetchOnce ?? fetchAllowlistedOnce;
  const registry = new URL(DEFAULT_NPM_REGISTRY_URL);
  const metadataUrl = `${registry.origin}/${encodeURIComponent(spec.name).replace(/^%40/u, "@")}/${encodeURIComponent(spec.version ?? "latest")}`;
  const guard = (maxResponseBytes: number) => ({
    allowlist: [...input.networkAllowlist],
    maxResponseBytes,
    bodyReadTimeoutMs: NETWORK_TIMEOUT_MS,
    init: { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS), redirect: "error" as const },
  });

  let dist: { tarball?: unknown; integrity?: unknown } | undefined;
  try {
    const response = await fetchOnce(metadataUrl, guard(METADATA_MAX_BYTES));
    if (!response.ok) throw new RegistryReason(`registry_status_${response.status}`);
    const body = await readBoundedResponseJson<{ dist?: { tarball?: unknown; integrity?: unknown } }>(response, {
      maxBytes: METADATA_MAX_BYTES,
      timeoutMs: NETWORK_TIMEOUT_MS,
      label: "npm registry metadata",
    });
    dist = body?.dist;
  } catch (error) {
    return { status: "unknown", warnings: [unverifiable(registryFailureReason(error))] };
  }

  const invalid: PluginPackageIntegrityResult = {
    status: "unknown",
    warnings: [
      warning(
        "integrity_registry_invalid",
        "critical",
        "The registry metadata did not provide an https tarball on the registry host and a sha512 integrity.",
      ),
    ],
  };
  const registryIntegrity = typeof dist?.integrity === "string" ? parseSriIntegrity(dist.integrity) : undefined;
  if (!registryIntegrity || registryIntegrity.algorithm !== "sha512" || typeof dist?.tarball !== "string") {
    return invalid;
  }
  let tarball: URL;
  try {
    tarball = new URL(dist.tarball);
  } catch {
    return invalid;
  }
  if (tarball.protocol !== "https:" || tarball.host !== registry.host || tarball.username || tarball.password) {
    return invalid;
  }

  let bytes: Uint8Array;
  try {
    const response = await fetchOnce(tarball.toString(), guard(PLUGIN_TARBALL_MAX_BYTES));
    if (!response.ok) throw new RegistryReason(`registry_status_${response.status}`);
    bytes = await readBoundedResponseBytes(response, {
      maxBytes: PLUGIN_TARBALL_MAX_BYTES,
      timeoutMs: NETWORK_TIMEOUT_MS,
      label: "npm plugin tarball",
    });
  } catch (error) {
    return { status: "unknown", warnings: [unverifiable(registryFailureReason(error))] };
  }

  const sha512 = createHash("sha512").update(bytes).digest();
  const actual = `sha512-${sha512.toString("base64")}`;
  if (actual !== dist.integrity || (expected !== undefined && actual !== expected)) {
    return {
      status: "quarantined",
      actualIntegrity: actual,
      expectedIntegrity: expected ?? String(dist.integrity),
      warnings: [MISMATCH],
    };
  }
  const artifactPath = await storeTarball(
    input.pluginStoreRoot,
    input.pluginId,
    sha512.toString("hex").slice(0, 16),
    bytes,
  );
  return {
    status: "verified",
    actualIntegrity: actual,
    integritySource: expected ? "operator" : "registry",
    verifiedAt: now().toISOString(),
    artifactPath,
    warnings: expected
      ? []
      : [
          warning(
            "integrity_not_pinned",
            "warning",
            "Verified against the registry's published integrity; pin an expectedIntegrity to detect a re-published package.",
          ),
        ],
  };
}

async function storeTarball(
  storeRoot: string,
  pluginId: string,
  hashPrefix: string,
  bytes: Uint8Array,
): Promise<string> {
  assertSafePluginId(pluginId);
  const root = path.resolve(storeRoot);
  await mkdir(root, { recursive: true });
  await assertOrdinaryPath(root);
  const pluginDir = path.join(root, pluginId);
  await mkdir(pluginDir, { recursive: true });
  await assertOrdinaryPath(pluginDir);
  const staging = await mkdtemp(path.join(pluginDir, ".install-"));
  if (path.dirname(staging) !== pluginDir || !path.basename(staging).startsWith(".install-")) {
    throw new Error("Plugin package staging ownership could not be established.");
  }
  try {
    const staged = path.join(staging, "package.tgz");
    await writeFile(staged, bytes, { flag: "wx", mode: 0o600 });
    const filename = `${hashPrefix}.tgz`;
    await rename(staged, path.join(pluginDir, filename));
    return path.relative(path.dirname(root), path.join(pluginDir, filename)).split(path.sep).join("/");
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function assertOrdinaryPath(target: string): Promise<void> {
  for (let current = path.resolve(target); ; current = path.dirname(current)) {
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Plugin package storage must use ordinary directories.");
    }
    if (path.dirname(current) === current) break;
  }
  const normalize = (value: string) =>
    process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (normalize(await realpath(target)) !== normalize(target)) {
    throw new Error("Plugin package storage path changed during resolution.");
  }
}
