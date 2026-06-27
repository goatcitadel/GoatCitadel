import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import AdmZip from "adm-zip";
import { readBoundedResponseBytes } from "../services/bounded-response-reader.js";

const MAX_VOICE_RUNTIME_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const VOICE_RUNTIME_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

export async function downloadFile(url: string, destinationPath: string, expectedSha256: string): Promise<void> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "GoatCitadel/1.0.0",
    },
  });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status} ${response.statusText}) for ${url}`);
  }
  const buffer = Buffer.from(
    await readBoundedResponseBytes(response, {
      maxBytes: MAX_VOICE_RUNTIME_DOWNLOAD_BYTES,
      timeoutMs: VOICE_RUNTIME_DOWNLOAD_TIMEOUT_MS,
      label: "Voice runtime download",
    }),
  );
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  if (sha256 !== expectedSha256) {
    throw new Error(
      `Checksum mismatch for ${path.basename(destinationPath)} (expected ${expectedSha256}, got ${sha256})`,
    );
  }
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.writeFile(destinationPath, buffer);
}

export async function extractZip(archivePath: string, destinationDir: string): Promise<void> {
  await fs.mkdir(destinationDir, { recursive: true });
  const zip = new AdmZip(archivePath);
  zip.extractAllTo(destinationDir, true);
}

export async function extractTarGz(archivePath: string, destinationDir: string): Promise<void> {
  await fs.mkdir(destinationDir, { recursive: true });
  runCommand("tar", ["-xzf", archivePath, "-C", destinationDir], "Failed to extract whisper.cpp source archive.");
}

export async function extractGzip(archivePath: string, destinationPath: string): Promise<void> {
  const compressed = await fs.readFile(archivePath);
  const buffer = gunzipSync(compressed);
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.writeFile(destinationPath, buffer);
}

export function runCommand(command: string, args: string[], failureMessage: string, cwd?: string): void {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "pipe",
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = `${result.stderr ?? ""}`.trim();
    throw new Error(`${failureMessage}${stderr ? ` ${stderr}` : ""}`);
  }
}

export async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function findFileRecursive(rootDir: string, fileName: string): Promise<string | null> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isFile() && entry.name === fileName) {
      return fullPath;
    }
    if (entry.isDirectory()) {
      const nested = await findFileRecursive(fullPath, fileName);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}
