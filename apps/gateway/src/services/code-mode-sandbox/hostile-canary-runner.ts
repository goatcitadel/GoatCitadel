import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { CodeModeHostileSandboxCanary, CodeModeSandboxMetadata } from "@goatcitadel/contracts";
import type { CodeModeSandboxConfig } from "../../config.js";
import {
  prepareCodeModeSandboxLaunch,
  resolveCodeModeSandboxMetadata,
  type PrepareCodeModeSandboxLaunchOptions,
  type PreparedCodeModeSandboxLaunch,
} from "../code-mode-sandbox-runner.js";
import type { HostSandboxAdapterSelectionOptions } from "./host-sandbox-adapter.js";
import {
  buildHostileSandboxClaimMetadata,
  CODE_MODE_HOSTILE_SANDBOX_CANARIES,
  type CodeModeHostileSandboxClaimMetadata,
  type CodeModeHostileSandboxPlatformProof,
  type CodeModeSandboxLaunchInput,
  type CodeModeSandboxLaunchSpec,
  type CodeModeSandboxPlatform,
} from "./types.js";

const CODE_MODE_ENV_PASSTHROUGH_KEYS = [
  "SystemRoot",
  "SYSTEMROOT",
  "ComSpec",
  "WINDIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "ALLUSERSPROFILE",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
];
const HOSTILE_CANARY_SECRET_ENV = "GOATCITADEL_HOSTILE_CANARY_SECRET";
const HOSTILE_CANARY_SECRET_VALUE = "goatcitadel-hostile-canary-synthetic-secret";
const HOSTILE_CANARY_TIMEOUT_MS = 15_000;

export interface CodeModeHostileSandboxCanaryResult {
  name: CodeModeHostileSandboxCanary;
  passed: boolean;
  detail?: string;
}

export interface CodeModeHostileSandboxProof {
  generatedAt: string;
  platform: CodeModeSandboxPlatform;
  sandboxRequired: boolean;
  sandboxAvailable: boolean;
  metadata: CodeModeSandboxMetadata;
  currentPlatformProof: CodeModeHostileSandboxPlatformProof;
  claim: CodeModeHostileSandboxClaimMetadata;
  canaries: CodeModeHostileSandboxCanaryResult[];
  setupWarnings: string[];
  liveLaunch?: {
    transport: CodeModeSandboxLaunchSpec["transport"];
    executable: string;
    cwd: string;
    advisoryUnsandboxed: boolean;
    generatedArtifacts: string[];
  };
  runtime?: {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    artifactSha256?: string;
    reportPath?: string;
    tempRoot?: string;
  };
}

export interface RunCodeModeHostileSandboxCanariesOptions extends HostSandboxAdapterSelectionOptions {
  evidenceRef?: string;
  preserveTempRoot?: boolean;
  tempRoot?: string;
  now?: () => Date;
  prepareLaunch?: (
    config: CodeModeSandboxConfig,
    input: CodeModeSandboxLaunchInput,
    options?: PrepareCodeModeSandboxLaunchOptions,
  ) => Promise<PreparedCodeModeSandboxLaunch>;
  spawnLaunch?: (launch: CodeModeSandboxLaunchSpec) => Promise<{ code: number | null; stdout: string; stderr: string }>;
}

export async function runCodeModeHostileSandboxCanaries(
  config: CodeModeSandboxConfig,
  options: RunCodeModeHostileSandboxCanariesOptions = {},
): Promise<CodeModeHostileSandboxProof> {
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const adapterOptions = {
    platform: options.platform,
    resolveCommand: options.resolveCommand,
    osRelease: options.osRelease,
  };
  const metadata = resolveCodeModeSandboxMetadata(config, adapterOptions);
  const tempRoot = await fs.mkdtemp(path.join(options.tempRoot ?? os.tmpdir(), "goatcitadel-hostile-sandbox-"));
  const canaries: CodeModeHostileSandboxCanaryResult[] = [];
  const setupWarnings: string[] = [];
  let liveLaunch: CodeModeHostileSandboxProof["liveLaunch"];
  let runtime: CodeModeHostileSandboxProof["runtime"];
  let server: Server | undefined;

  try {
    const failClosed = await runFailClosedRequiredModeCanary(config, tempRoot, adapterOptions, options);
    canaries.push(failClosed);

    if (metadata.available) {
      const fixture = await createCanaryFixture(tempRoot);
      setupWarnings.push(...fixture.setupWarnings);
      server = await startNetworkCanaryServer();
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      if (!port) {
        throw new Error("Unable to start hostile sandbox network canary listener.");
      }

      const prepared = await (options.prepareLaunch ?? prepareCodeModeSandboxLaunch)(
        config,
        {
          runId: "hostile-sandbox-canaries",
          nodePath: process.execPath,
          harnessPath: fixture.harnessPath,
          runTempRoot: fixture.runTempRoot,
          heapMb: 96,
          env: buildHostileCanaryEnv(
            { ...process.env, [HOSTILE_CANARY_SECRET_ENV]: HOSTILE_CANARY_SECRET_VALUE },
            {
              GOATCITADEL_HOSTILE_CANARY_REPORT_PATH: fixture.reportPath,
              GOATCITADEL_HOSTILE_CANARY_ARTIFACT_PATH: fixture.artifactPath,
              GOATCITADEL_HOSTILE_CANARY_ARTIFACT_TEXT: fixture.artifactText,
              GOATCITADEL_HOSTILE_CANARY_EXPECTED_SHA256: fixture.expectedArtifactHash,
              GOATCITADEL_HOSTILE_CANARY_OUTSIDE_READ_PATH: fixture.outsideReadPath,
              GOATCITADEL_HOSTILE_CANARY_OUTSIDE_WRITE_PATH: fixture.outsideWritePath,
              GOATCITADEL_HOSTILE_CANARY_TRAVERSAL_PATH: fixture.traversalPath,
              GOATCITADEL_HOSTILE_CANARY_SYMLINK_PATH: fixture.symlinkPath,
              GOATCITADEL_HOSTILE_CANARY_SYMLINK_CREATED: fixture.symlinkCreated ? "1" : "0",
              GOATCITADEL_HOSTILE_CANARY_NETWORK_HOST: "127.0.0.1",
              GOATCITADEL_HOSTILE_CANARY_NETWORK_PORT: String(port),
            },
          ),
        },
        {
          ...adapterOptions,
          metadata,
        },
      );
      liveLaunch = {
        transport: prepared.launch.transport,
        executable: path.basename(prepared.launch.executable),
        cwd: prepared.launch.cwd,
        advisoryUnsandboxed: prepared.launch.advisoryUnsandboxed,
        generatedArtifacts: prepared.launch.generatedArtifacts.map((artifact) => path.basename(artifact)),
      };
      const result = await (options.spawnLaunch ?? spawnCodeModeSandboxLaunch)(prepared.launch);
      runtime = {
        exitCode: result.code,
        stdout: redactCanaryOutput(result.stdout),
        stderr: redactCanaryOutput(result.stderr),
        reportPath: fixture.reportPath,
        tempRoot: options.preserveTempRoot ? tempRoot : undefined,
      };
      if (result.code === 0) {
        const report = await readCanaryReport(fixture.reportPath);
        canaries.push(...report.results);
        runtime.artifactSha256 = await hashFileIfExists(fixture.artifactPath);
        enforceParentSideCanaryChecks(canaries, fixture, runtime.artifactSha256);
      } else {
        canaries.push(...failedCanaryResults(CODE_MODE_HOSTILE_SANDBOX_CANARIES, canaries, "live launch failed"));
      }
    } else {
      canaries.push(...failedCanaryResults(CODE_MODE_HOSTILE_SANDBOX_CANARIES, canaries, "native sandbox unavailable"));
    }
  } catch (error) {
    setupWarnings.push(error instanceof Error ? error.message : String(error));
    canaries.push(...failedCanaryResults(CODE_MODE_HOSTILE_SANDBOX_CANARIES, canaries, "canary runner failed"));
  } finally {
    await closeServer(server);
    if (!options.preserveTempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }

  const currentPlatformProof = buildCurrentPlatformProof(
    metadata.platform,
    metadata.available,
    canaries,
    generatedAt,
    options.evidenceRef,
  );
  const claim = buildHostileSandboxClaimMetadata(metadata.platform, [currentPlatformProof]);
  return {
    generatedAt,
    platform: metadata.platform,
    sandboxRequired: metadata.required,
    sandboxAvailable: metadata.available,
    metadata,
    currentPlatformProof,
    claim,
    canaries: sortCanaries(canaries),
    setupWarnings,
    liveLaunch,
    runtime,
  };
}

function buildCurrentPlatformProof(
  platform: CodeModeSandboxPlatform,
  sandboxAvailable: boolean,
  canaries: CodeModeHostileSandboxCanaryResult[],
  checkedAt: string,
  evidenceRef?: string,
): CodeModeHostileSandboxPlatformProof {
  const sortedCanaries = sortCanaries(canaries);
  const checksPassed = sortedCanaries.filter((result) => result.passed).map((result) => result.name);
  const checksFailed = sortedCanaries.filter((result) => !result.passed).map((result) => result.name);
  const allCanariesAccountedFor = CODE_MODE_HOSTILE_SANDBOX_CANARIES.every((canary) =>
    sortedCanaries.some((result) => result.name === canary),
  );
  const status = !sandboxAvailable
    ? "missing"
    : checksFailed.length === 0 && allCanariesAccountedFor
      ? "pass"
      : checksPassed.length > 0
        ? "fail"
        : "missing";
  return {
    platform,
    status,
    checksPassed,
    checksFailed,
    evidenceRef,
    checkedAt,
  };
}

async function runFailClosedRequiredModeCanary(
  config: CodeModeSandboxConfig,
  tempRoot: string,
  adapterOptions: HostSandboxAdapterSelectionOptions,
  options: RunCodeModeHostileSandboxCanariesOptions,
): Promise<CodeModeHostileSandboxCanaryResult> {
  const runTempRoot = path.join(tempRoot, "fail-closed-required-mode");
  const harnessPath = path.join(runTempRoot, "fail-closed-harness.mjs");
  await fs.mkdir(runTempRoot, { recursive: true });
  await fs.writeFile(harnessPath, "process.exit(0);\n", "utf8");
  const requiredConfig: CodeModeSandboxConfig = {
    ...config,
    required: true,
    bestEffortHostEnabled: true,
  };
  const unavailableAdapterOptions: HostSandboxAdapterSelectionOptions = {
    ...adapterOptions,
    resolveCommand: () => undefined,
  };
  const unavailableMetadata = resolveCodeModeSandboxMetadata(requiredConfig, unavailableAdapterOptions);
  try {
    await (options.prepareLaunch ?? prepareCodeModeSandboxLaunch)(
      requiredConfig,
      {
        runId: "hostile-sandbox-fail-closed",
        nodePath: process.execPath,
        harnessPath,
        runTempRoot,
        heapMb: 32,
        env: buildHostileCanaryEnv(process.env, {}),
      },
      {
        ...unavailableAdapterOptions,
        metadata: unavailableMetadata,
      },
    );
    return {
      name: "fail_closed_required_mode",
      passed: false,
      detail: "required sandbox launch returned even though native prerequisites were unavailable",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "fail_closed_required_mode",
      passed: /failed closed|unavailable|missing|unsupported/i.test(message),
      detail: clampForEvidence(message, 320),
    };
  }
}

interface CanaryFixture {
  runTempRoot: string;
  harnessPath: string;
  reportPath: string;
  artifactPath: string;
  artifactText: string;
  expectedArtifactHash: string;
  outsideReadPath: string;
  outsideWritePath: string;
  traversalPath: string;
  symlinkPath: string;
  symlinkCreated: boolean;
  setupWarnings: string[];
}

async function createCanaryFixture(tempRoot: string): Promise<CanaryFixture> {
  const runTempRoot = path.join(tempRoot, "run");
  const outsideRoot = path.join(tempRoot, "outside");
  await fs.mkdir(runTempRoot, { recursive: true });
  await fs.mkdir(outsideRoot, { recursive: true });
  const outsideReadPath = path.join(outsideRoot, "host-secret.txt");
  const outsideWritePath = path.join(outsideRoot, "host-write.txt");
  const traversalPath = path.join(runTempRoot, "..", "outside", "host-secret.txt");
  const symlinkPath = path.join(runTempRoot, "symlink-to-outside-secret");
  const setupWarnings: string[] = [];
  await fs.writeFile(outsideReadPath, "outside-root-secret", "utf8");
  let symlinkCreated = false;
  try {
    await fs.symlink(outsideReadPath, symlinkPath, "file");
    symlinkCreated = true;
  } catch (error) {
    setupWarnings.push(`symlink setup unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const harnessPath = path.join(runTempRoot, "hostile-canary-harness.mjs");
  const reportPath = path.join(runTempRoot, "hostile-canary-report.json");
  const artifactPath = path.join(runTempRoot, "hostile-canary-artifact.txt");
  const artifactText = "hostile sandbox artifact integrity sentinel";
  await fs.writeFile(harnessPath, HOSTILE_CANARY_HARNESS_SOURCE, "utf8");
  return {
    runTempRoot,
    harnessPath,
    reportPath,
    artifactPath,
    artifactText,
    expectedArtifactHash: sha256Text(artifactText),
    outsideReadPath,
    outsideWritePath,
    traversalPath,
    symlinkPath,
    symlinkCreated,
    setupWarnings,
  };
}

function buildHostileCanaryEnv(hostEnv: NodeJS.ProcessEnv, additions: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GOATCITADEL_CODE_MODE: "1",
    TZ: hostEnv.TZ ?? "UTC",
    ...additions,
  };
  for (const key of CODE_MODE_ENV_PASSTHROUGH_KEYS) {
    const value = hostEnv[key];
    if (value) {
      env[key] = value;
    }
  }
  delete env[HOSTILE_CANARY_SECRET_ENV];
  return env;
}

async function startNetworkCanaryServer(): Promise<Server> {
  const server = createServer((socket) => {
    socket.on("error", () => {
      // The canary client intentionally destroys the socket as soon as it proves reachability.
    });
    socket.end("host-network-canary");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) {
    return;
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function spawnCodeModeSandboxLaunch(
  launch: CodeModeSandboxLaunchSpec,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.executable, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Hostile sandbox canary launch timed out."));
    }, HOSTILE_CANARY_TIMEOUT_MS);
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

interface HarnessReport {
  results: CodeModeHostileSandboxCanaryResult[];
}

async function readCanaryReport(reportPath: string): Promise<HarnessReport> {
  const raw = await fs.readFile(reportPath, "utf8");
  const parsed = JSON.parse(raw) as HarnessReport;
  return {
    results: parsed.results.filter((result) => CODE_MODE_HOSTILE_SANDBOX_CANARIES.includes(result.name)),
  };
}

function enforceParentSideCanaryChecks(
  canaries: CodeModeHostileSandboxCanaryResult[],
  fixture: CanaryFixture,
  artifactSha256: string | undefined,
): void {
  if (artifactSha256 !== fixture.expectedArtifactHash) {
    upsertCanary(canaries, {
      name: "artifact_hash_integrity",
      passed: false,
      detail: `artifact hash mismatch: ${artifactSha256 ?? "missing"}`,
    });
  }
}

function upsertCanary(canaries: CodeModeHostileSandboxCanaryResult[], next: CodeModeHostileSandboxCanaryResult): void {
  const existingIndex = canaries.findIndex((item) => item.name === next.name);
  if (existingIndex === -1) {
    canaries.push(next);
    return;
  }
  canaries[existingIndex] = next;
}

function failedCanaryResults(
  canaries: readonly CodeModeHostileSandboxCanary[],
  existing: CodeModeHostileSandboxCanaryResult[],
  detail: string,
): CodeModeHostileSandboxCanaryResult[] {
  const existingNames = new Set(existing.map((result) => result.name));
  return canaries
    .filter((canary) => !existingNames.has(canary))
    .map((canary) => ({
      name: canary,
      passed: false,
      detail,
    }));
}

function sortCanaries(canaries: CodeModeHostileSandboxCanaryResult[]): CodeModeHostileSandboxCanaryResult[] {
  const byName = new Map(canaries.map((result) => [result.name, result]));
  return CODE_MODE_HOSTILE_SANDBOX_CANARIES.flatMap((canary) => {
    const result = byName.get(canary);
    return result ? [result] : [];
  });
}

async function hashFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return sha256Text(await fs.readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function redactCanaryOutput(value: string): string {
  return clampForEvidence(value.replaceAll(HOSTILE_CANARY_SECRET_VALUE, "[REDACTED]"), 1200);
}

function clampForEvidence(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

const HOSTILE_CANARY_HARNESS_SOURCE = String.raw`import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";

const results = [];

function record(name, passed, detail) {
  results.push({ name, passed: Boolean(passed), ...(detail ? { detail: String(detail).slice(0, 320) } : {}) });
}

function denied(operation) {
  try {
    operation();
    return false;
  } catch {
    return true;
  }
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function networkConnected(host, port) {
  return await new Promise((resolve) => {
    const socket = net.connect({ host, port: Number(port) });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 500);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function processSpawnBlocked() {
  return await new Promise((resolve) => {
    let settled = false;
    function settle(value) {
      if (settled) return;
      settled = true;
      resolve(value);
    }
    try {
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 2000)"], { stdio: "ignore" });
      child.once("error", () => settle(true));
      child.once("spawn", () => {
        child.kill();
        settle(false);
      });
      child.once("close", (code, signal) => {
        settle(code !== 0 || Boolean(signal));
      });
      setTimeout(() => {
        child.kill();
        settle(false);
      }, 750);
    } catch {
      settle(true);
    }
  });
}

const outsideReadPath = process.env.GOATCITADEL_HOSTILE_CANARY_OUTSIDE_READ_PATH;
const outsideWritePath = process.env.GOATCITADEL_HOSTILE_CANARY_OUTSIDE_WRITE_PATH;
const traversalPath = process.env.GOATCITADEL_HOSTILE_CANARY_TRAVERSAL_PATH;
const symlinkPath = process.env.GOATCITADEL_HOSTILE_CANARY_SYMLINK_PATH;
const symlinkCreated = process.env.GOATCITADEL_HOSTILE_CANARY_SYMLINK_CREATED === "1";
const artifactPath = process.env.GOATCITADEL_HOSTILE_CANARY_ARTIFACT_PATH;
const artifactText = process.env.GOATCITADEL_HOSTILE_CANARY_ARTIFACT_TEXT;
const expectedArtifactHash = process.env.GOATCITADEL_HOSTILE_CANARY_EXPECTED_SHA256;
const reportPath = process.env.GOATCITADEL_HOSTILE_CANARY_REPORT_PATH;

record("outside_root_read_denied", denied(() => fs.readFileSync(outsideReadPath, "utf8")));
record("outside_root_write_denied", denied(() => fs.writeFileSync(outsideWritePath, "unsafe-write", "utf8")));
record("env_secret_absent", process.env.GOATCITADEL_HOSTILE_CANARY_SECRET === undefined);

const traversalDenied = denied(() => fs.readFileSync(traversalPath, "utf8"));
const symlinkDenied = symlinkCreated ? denied(() => fs.readFileSync(symlinkPath, "utf8")) : true;
record(
  "symlink_path_traversal_denied",
  traversalDenied && symlinkDenied,
  symlinkCreated ? undefined : "symlink setup unavailable; traversal denial was exercised",
);

const connected = await networkConnected(
  process.env.GOATCITADEL_HOSTILE_CANARY_NETWORK_HOST,
  process.env.GOATCITADEL_HOSTILE_CANARY_NETWORK_PORT,
);
record("network_denied", !connected);
record("process_job_limits_enforced", await processSpawnBlocked());

fs.writeFileSync(artifactPath, artifactText, "utf8");
const artifactHash = sha256Text(fs.readFileSync(artifactPath, "utf8"));
record("artifact_hash_integrity", artifactHash === expectedArtifactHash, artifactHash);
fs.writeFileSync(reportPath, JSON.stringify({ results }, null, 2), "utf8");
`;
