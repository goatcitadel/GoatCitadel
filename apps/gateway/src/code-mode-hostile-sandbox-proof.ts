import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { loadGatewayConfig } from "./config.js";
import type { CodeModeHostileSandboxPlatformProof } from "./services/code-mode-sandbox/types.js";
import { runCodeModeHostileSandboxCanaries } from "./services/code-mode-sandbox/hostile-canary-runner.js";

interface CliOptions {
  output?: string;
  platformProofs: string[];
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseCliOptions(args);
  const rootDir = path.resolve(process.env.GOATCITADEL_ROOT_DIR?.trim() || process.cwd());
  const config = await loadGatewayConfig(rootDir);
  const platformProofs = await readPlatformProofFiles(options.platformProofs);
  const proof = await runCodeModeHostileSandboxCanaries(config.assistant.capabilities.codeModeSandbox, {
    evidenceRef: options.output ? path.basename(options.output) : undefined,
    platformProofs,
  });
  await writeProof(options, proof);
  process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
  if (proof.sandboxAvailable && proof.currentPlatformProof.status !== "pass") {
    throw new Error(
      `Hostile Code Mode sandbox canaries failed on ${proof.platform}: ${proof.currentPlatformProof.checksFailed.join(", ")}.`,
    );
  }
}

export function parseCliOptions(args: string[]): CliOptions {
  const options: CliOptions = { platformProofs: [] };
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === "--output") {
      const value = args[index + 1];
      if (value) {
        options.output = value;
      }
      index += 1;
    } else if (item?.startsWith("--output=")) {
      options.output = item.slice("--output=".length);
    } else if (item === "--platform-proof") {
      const value = args[index + 1];
      if (value) {
        options.platformProofs.push(value);
      }
      index += 1;
    } else if (item?.startsWith("--platform-proof=")) {
      options.platformProofs.push(item.slice("--platform-proof=".length));
    }
  }
  return options;
}

async function readPlatformProofFiles(files: string[]): Promise<CodeModeHostileSandboxPlatformProof[]> {
  const proofs: CodeModeHostileSandboxPlatformProof[] = [];
  for (const file of files.map((item) => item?.trim()).filter(Boolean)) {
    const payload = JSON.parse(await fs.readFile(path.resolve(file), "utf8")) as unknown;
    proofs.push(...extractPlatformProofs(payload));
  }
  return proofs;
}

function extractPlatformProofs(payload: unknown): CodeModeHostileSandboxPlatformProof[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const record = payload as Record<string, unknown>;
  const currentPlatformProof = normalizePlatformProof(record.currentPlatformProof);
  const claimProofs = normalizeProofList((record.claim as Record<string, unknown> | undefined)?.platformProof);
  const directProofs = normalizeProofList(record.platformProof);
  return [...(currentPlatformProof ? [currentPlatformProof] : []), ...claimProofs, ...directProofs];
}

function normalizeProofList(value: unknown): CodeModeHostileSandboxPlatformProof[] {
  return Array.isArray(value) ? value.map(normalizePlatformProof).filter(isPlatformProof) : [];
}

function normalizePlatformProof(value: unknown): CodeModeHostileSandboxPlatformProof | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Partial<CodeModeHostileSandboxPlatformProof>;
  if (record.platform !== "linux" && record.platform !== "darwin" && record.platform !== "win32") {
    return undefined;
  }
  if (record.status !== "pass" && record.status !== "fail" && record.status !== "missing") {
    return undefined;
  }
  return {
    platform: record.platform,
    status: record.status,
    checksPassed: Array.isArray(record.checksPassed) ? record.checksPassed.filter(isString) : [],
    checksFailed: Array.isArray(record.checksFailed) ? record.checksFailed.filter(isString) : [],
    evidenceRef: typeof record.evidenceRef === "string" ? record.evidenceRef : undefined,
    checkedAt: typeof record.checkedAt === "string" ? record.checkedAt : undefined,
  };
}

function isPlatformProof(
  value: CodeModeHostileSandboxPlatformProof | undefined,
): value is CodeModeHostileSandboxPlatformProof {
  return Boolean(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

async function writeProof(options: CliOptions, proof: unknown): Promise<void> {
  if (!options.output) {
    return;
  }
  await fs.mkdir(path.dirname(options.output), { recursive: true });
  await fs.writeFile(options.output, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
}
