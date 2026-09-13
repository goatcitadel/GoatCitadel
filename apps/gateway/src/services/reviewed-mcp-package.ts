import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { fetchAllowlistedOnce } from "@goatcitadel/policy-engine";
import { readBoundedResponseBytes } from "./bounded-response-reader.js";
import { terminateProcessTree } from "./process-tree-killer.js";
import { REVIEWED_PLAYWRIGHT_PACKAGE as manifest } from "./reviewed-mcp-package-manifest.js";

export const REVIEWED_PLAYWRIGHT_MANIFEST_SHA256 = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
type ReviewedPackage = (typeof manifest.packages)[number];
export interface ReviewedMcpPackageOptions {
  /** Gateway-owned data directory; never accepted from a tool request. */
  packageRoot?: string;
  networkAllowlist?: string[];
  signal?: AbortSignal;
}
const installations = new Map<string, Promise<void>>();
const DOWNLOAD_LIMIT = 32 * 1024 * 1024;

/** Only the exact shipped template opts into the reviewed installer. Legacy/custom
 * stdio definitions retain their existing trusted-process execution semantics. */
export function isReviewedPlaywrightServer(server: Pick<McpServerRecord, "command" | "args" | "transport">): boolean {
  return (
    server.transport === "stdio" &&
    /(?:^|[\\/])npx(?:\.cmd)?$/iu.test(server.command ?? "") &&
    server.args?.[0] === "-y" &&
    server.args[1] === manifest.packageSpec
  );
}

export async function resolveReviewedMcpLaunch(
  server: McpServerRecord,
  options: ReviewedMcpPackageOptions,
): Promise<{ command: string; args: string[] } | undefined> {
  if (!isReviewedPlaywrightServer(server)) return undefined;
  if (!options.packageRoot) throw new Error("The Gateway package storage owner is unavailable.");
  options.signal?.throwIfAborted();
  const root = path.resolve(options.packageRoot);
  await mkdir(root, { recursive: true });
  await assertOrdinaryPath(root);
  const destination = path.join(root, REVIEWED_PLAYWRIGHT_MANIFEST_SHA256);
  let pending = installations.get(destination);
  if (!pending) {
    pending = ensureInstalled(root, destination, options);
    installations.set(destination, pending);
  }
  try {
    await pending;
  } finally {
    if (installations.get(destination) === pending) installations.delete(destination);
  }
  options.signal?.throwIfAborted();
  // A receipt or previous successful launch is not proof of the current bytes.
  await verifyReviewedMcpTree(destination);
  return {
    command: process.execPath,
    args: [path.join(destination, "node_modules", manifest.entrypoint), ...server.args!.slice(2)],
  };
}

async function ensureInstalled(root: string, destination: string, options: ReviewedMcpPackageOptions): Promise<void> {
  if (await exists(destination)) return; // Corrupt existing installations fail verification; never silently replace them.
  const staging = await mkdtemp(path.join(root, ".install-"));
  if (path.dirname(staging) !== root || !path.basename(staging).startsWith(".install-")) {
    throw new Error("Reviewed package staging ownership could not be established.");
  }
  try {
    for (const pkg of manifest.packages) {
      options.signal?.throwIfAborted();
      const signal = options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000);
      const response = await fetchAllowlistedOnce(pkg.url, {
        allowlist: options.networkAllowlist ?? [],
        maxResponseBytes: DOWNLOAD_LIMIT,
        bodyReadTimeoutMs: 60_000,
        init: { signal, redirect: "error" },
      });
      if (!response.ok) throw new Error(`Reviewed MCP package download failed (${response.status}).`);
      const bytes = await readBoundedResponseBytes(response, {
        maxBytes: DOWNLOAD_LIMIT,
        timeoutMs: 60_000,
        label: "reviewed MCP package",
      });
      verifyReviewedArchive(bytes, pkg.integrity);
      const archive = path.join(staging, "archive.tgz");
      const extracted = path.join(staging, "extracted");
      await writeFile(archive, bytes, { flag: "wx", mode: 0o600 });
      await mkdir(extracted);
      // Only a byte-identical reviewed archive reaches the platform extractor.
      // No npm lifecycle scripts, dependency resolution, user config, or credentials.
      await extractReviewedArchive(archive, extracted, signal);
      const packageDir = path.join(extracted, "package");
      await verifyPackageTree(packageDir, pkg);
      const installed = path.join(staging, "node_modules", pkg.name);
      await mkdir(path.dirname(installed), { recursive: true });
      await rename(packageDir, installed);
      await rm(extracted, { recursive: true });
      await rm(archive);
    }
    await writeFile(path.join(staging, "manifest.json"), JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    await verifyReviewedMcpTree(staging);
    try {
      await rename(staging, destination);
    } catch (error) {
      // A second Gateway may have completed the same immutable installation.
      if (!(await exists(destination))) throw error;
      await verifyReviewedMcpTree(destination);
    }
  } finally {
    // mkdtemp created this exact child under the validated owner root.
    await rm(staging, { recursive: true, force: true });
  }
}

export function verifyReviewedArchive(bytes: Uint8Array, integrity: string): void {
  const actual = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (actual !== integrity) throw new Error("Reviewed MCP archive integrity does not match. Nothing was executed.");
}

/** Exported for the offline installation verifier, never for caller-chosen manifests. */
export async function verifyReviewedMcpTree(root: string): Promise<void> {
  await assertOrdinaryPath(root);
  const allowed = new Set(["manifest.json", "node_modules"]);
  if ((await readdir(root)).some((name) => !allowed.has(name)))
    throw new Error("Reviewed MCP installation has extra files.");
  await assertOrdinaryPath(path.join(root, "node_modules"));
  if ((await readdir(path.join(root, "node_modules"))).sort().join(",") !== "@playwright,playwright,playwright-core") {
    throw new Error("Reviewed MCP dependency set changed.");
  }
  await assertOrdinaryPath(path.join(root, "node_modules", "@playwright"));
  if ((await readdir(path.join(root, "node_modules", "@playwright"))).join(",") !== "mcp") {
    throw new Error("Reviewed MCP scoped dependency set changed.");
  }
  for (const pkg of manifest.packages) await verifyPackageTree(path.join(root, "node_modules", pkg.name), pkg);
}

async function verifyPackageTree(root: string, expected: ReviewedPackage): Promise<void> {
  await assertOrdinaryPath(root);
  const entries: Array<[string, number, string]> = [];
  let total = 0;
  const visit = async (relative: string): Promise<void> => {
    for (const item of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${item.name}` : item.name;
      const filename = path.join(root, name);
      const stat = await lstat(filename);
      if (stat.isSymbolicLink()) throw new Error("Reviewed MCP package contains a link.");
      if (stat.isDirectory()) {
        if (name.split("/").length > 12) throw new Error("Reviewed MCP directory depth changed.");
        await visit(name);
      } else if (stat.isFile() && stat.nlink === 1) {
        total += stat.size;
        if (entries.length >= expected.files || total > expected.bytes)
          throw new Error("Reviewed MCP package bounds changed.");
        const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const held = await handle.stat();
          if (!held.isFile() || held.ino !== stat.ino || held.dev !== stat.dev || held.size !== stat.size) {
            throw new Error("Reviewed MCP file changed during verification.");
          }
          const bytes = Buffer.alloc(held.size);
          let offset = 0;
          while (offset < bytes.length) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (!bytesRead) throw new Error("Reviewed MCP file size changed.");
            offset += bytesRead;
          }
          const after = await handle.stat();
          if (after.size !== held.size || after.mtimeMs !== held.mtimeMs)
            throw new Error("Reviewed MCP file changed during verification.");
          entries.push([name, bytes.length, createHash("sha256").update(bytes).digest("hex")]);
        } finally {
          await handle.close();
        }
      } else throw new Error("Reviewed MCP package contains an unsupported filesystem entry.");
    }
  };
  await visit("");
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (
    entries.length !== expected.files ||
    total !== expected.bytes ||
    createHash("sha256").update(JSON.stringify(entries)).digest("hex") !== expected.treeSha256
  ) {
    throw new Error(`Reviewed MCP package ${expected.name} differs from its approved artifact.`);
  }
}

async function assertOrdinaryPath(target: string): Promise<void> {
  for (let current = path.resolve(target); ; current = path.dirname(current)) {
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Reviewed MCP storage must use ordinary directories.");
    if (path.dirname(current) === current) break;
  }
  const normalize = (value: string) =>
    process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (normalize(await realpath(target)) !== normalize(target)) {
    throw new Error("Reviewed MCP storage path changed during resolution.");
  }
}
async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function extractReviewedArchive(archive: string, destination: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const command =
    process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, ["-xzf", archive, "-C", destination, "--no-same-owner", "--no-same-permissions"], {
      windowsHide: true,
      stdio: "ignore",
      cwd: destination,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    });
    const abort = () => terminateProcessTree({ child, label: "Reviewed MCP package extractor" });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.once("error", (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(new Error("Reviewed MCP installation was cancelled."));
      else if (code !== 0)
        reject(new Error("The platform archive extractor could not install the reviewed MCP package."));
      else resolve();
    });
  });
}
