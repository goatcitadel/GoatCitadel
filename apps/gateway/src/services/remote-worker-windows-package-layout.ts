import { createHash } from "node:crypto";
import type { RemoteWorkerInstalledTreeRole } from "./remote-worker-attestation-service.js";

export interface WindowsPackageLayout {
  readonly files: ReadonlyMap<
    string,
    { readonly sha256: string; readonly sizeBytes: number; readonly role: RemoteWorkerInstalledTreeRole }
  >;
  readonly directories: ReadonlySet<string>;
}

/** A pinned package inventory assigns roles; callers cannot supply arbitrary file-role overrides. */
export function parseWindowsPackageLayout(bytes: Buffer, expectedSha256: string): WindowsPackageLayout {
  const fail = (): never => {
    throw new Error("Remote worker Windows package inventory is invalid.");
  };
  if (
    !/^[a-f0-9]{64}$/u.test(expectedSha256) ||
    bytes.length > 1_048_576 ||
    createHash("sha256").update(bytes).digest("hex") !== expectedSha256
  )
    fail();
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail();
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail();
  const manifest = value as Record<string, unknown>;
  if (
    manifest.schemaVersion !== "goatcitadel.remote-worker-windows-package.v3" ||
    !["windows-x64", "windows-arm64"].includes(String(manifest.target)) ||
    manifest.entrypoint !== "app/worker/dist/main.js" ||
    manifest.nodeExecutable !== "app/runtime/node.exe" ||
    manifest.hostExecutable !== "bin/GoatCitadelRemoteWorkerHost.exe" ||
    !Array.isArray(manifest.files) ||
    manifest.files.length < 4 ||
    manifest.files.length >= 10_000
  )
    return fail();
  const files = new Map<string, { sha256: string; sizeBytes: number; role: RemoteWorkerInstalledTreeRole }>();
  const directories = new Set<string>();
  const folded = new Map<string, string>();
  for (const item of manifest.files) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return fail();
    const { path, sha256, sizeBytes } = item as Record<string, unknown>;
    if (
      typeof path !== "string" ||
      path.length > 4096 ||
      !/^(?:app|bin)\//u.test(path) ||
      typeof sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(sha256) ||
      typeof sizeBytes !== "number" ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 0 ||
      sizeBytes > 536_870_912
    )
      return fail();
    const segments = path.split("/");
    if (
      segments.some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          // eslint-disable-next-line no-control-regex -- rejecting control characters in a path segment is the point: this is the Windows illegal-character guard.
          /[\\:\x00-\x1f<>"|?*]/u.test(part) ||
          /[. ]$/u.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
      )
    )
      return fail();
    for (let i = 1; i <= segments.length; i++) {
      const entry = segments.slice(0, i).join("/");
      const previous = folded.get(entry.toLowerCase());
      if (previous !== undefined && previous !== entry) return fail();
      folded.set(entry.toLowerCase(), entry);
      if (i < segments.length) {
        if (files.has(entry)) return fail();
        directories.add(entry);
      }
    }
    if (files.has(path) || directories.has(path)) return fail();
    const role: RemoteWorkerInstalledTreeRole =
      path === "app/worker/dist/main.js"
        ? "bundle"
        : path === "app/pnpm-lock.yaml"
          ? "dependency_lock"
          : path === "bin/GoatCitadelRemoteWorkerHost.exe"
            ? "launcher"
            : path.startsWith("app/worker/node_modules/")
              ? "vendor"
              : "runtime";
    files.set(path, Object.freeze({ sha256, sizeBytes, role }));
  }
  for (const required of [
    "app/worker/dist/main.js",
    "app/pnpm-lock.yaml",
    "app/runtime/node.exe",
    "bin/GoatCitadelRemoteWorkerHost.exe",
  ]) {
    if (!files.has(required)) return fail();
  }
  if (![...files.values()].some((file) => file.role === "vendor")) return fail();
  files.set("worker-package.json", Object.freeze({ sha256: expectedSha256, sizeBytes: bytes.length, role: "runtime" }));
  return { files, directories };
}
