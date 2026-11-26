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

interface GitHubProofRun {
  commit: string;
  repository: string;
  runId: string;
  attempt: string;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseCliOptions(args);
  const rootDir = path.resolve(process.env.GOATCITADEL_ROOT_DIR?.trim() || process.cwd());
  const config = await loadGatewayConfig(rootDir);
  const githubRun = readCurrentGitHubRun();
  const imported = await Promise.all(options.platformProofs.map((file) => readPlatformProofFile(file, githubRun)));
  const result = await runCodeModeHostileSandboxCanaries(config.assistant.capabilities.codeModeSandbox, {
    evidenceRef: options.output ? path.basename(options.output) : undefined,
    platformProofs: imported.flatMap(({ proofs }) => proofs),
  });
  const proof = {
    ...result,
    githubRun,
    importedPlatformProofs: imported.map(({ githubRun: sourceRun, proofs }) => ({
      githubRun: sourceRun,
      platforms: [...new Set(proofs.map((item) => item.platform))],
    })),
  };
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
    const argument = args[index] ?? "";
    const equals = argument.indexOf("=");
    const option = equals === -1 ? argument : argument.slice(0, equals);
    if (option !== "--output" && option !== "--platform-proof") {
      throw new Error(`Unknown sandbox proof argument: ${argument}`);
    }
    const value = (equals === -1 ? args[++index] : argument.slice(equals + 1))?.trim();
    if (!value || value.startsWith("-")) {
      throw new Error(`${option} requires a nonempty path.`);
    }
    if (option === "--output") {
      options.output = value;
    } else {
      options.platformProofs.push(value);
    }
  }
  return options;
}

function readCurrentGitHubRun(): GitHubProofRun | null {
  if (process.env.GITHUB_ACTIONS !== "true") {
    return null;
  }
  const {
    GITHUB_SHA: commit,
    GITHUB_REPOSITORY: repository,
    GITHUB_RUN_ID: runId,
    GITHUB_RUN_ATTEMPT: attempt,
  } = process.env;
  if (!commit || !repository || !runId || !attempt) {
    throw new Error("GitHub Actions did not supply the sandbox proof commit, repository, run ID and attempt.");
  }
  return { commit, repository, runId, attempt };
}

async function readPlatformProofFile(file: string, currentRun: GitHubProofRun | null) {
  const payload = JSON.parse(await fs.readFile(path.resolve(file), "utf8")) as unknown;
  return parseImportedPlatformProof(payload, currentRun);
}

export function parseImportedPlatformProof(payload: unknown, currentRun: GitHubProofRun | null) {
  const artifact = payload as {
    githubRun?: Partial<GitHubProofRun>;
    platform?: unknown;
    currentPlatformProof?: unknown;
  } | null;
  const rawRun = artifact?.githubRun;
  const githubRun =
    typeof rawRun?.commit === "string" &&
    typeof rawRun.repository === "string" &&
    typeof rawRun.runId === "string" &&
    typeof rawRun.attempt === "string"
      ? { commit: rawRun.commit, repository: rawRun.repository, runId: rawRun.runId, attempt: rawRun.attempt }
      : null;
  if (!currentRun) {
    return { githubRun, proofs: extractPlatformProofs(payload) };
  }
  if (
    githubRun?.commit !== currentRun.commit ||
    githubRun.repository !== currentRun.repository ||
    githubRun.runId !== currentRun.runId ||
    githubRun.attempt !== currentRun.attempt
  ) {
    throw new Error(
      "Imported sandbox platform proof must match the current GitHub repository, commit and workflow run attempt.",
    );
  }
  const directProof = normalizePlatformProof(artifact?.currentPlatformProof);
  if (!directProof || directProof.platform !== artifact?.platform) {
    throw new Error("Imported GitHub sandbox proof must contain its own platform result.");
  }
  return { githubRun, proofs: [directProof] };
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
  if (
    record.status !== "pass" &&
    record.status !== "fail" &&
    record.status !== "missing" &&
    record.status !== "not_applicable"
  ) {
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
