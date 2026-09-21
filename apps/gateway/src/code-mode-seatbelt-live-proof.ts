// Live proof for the macOS Seatbelt Code Mode adapter (#145). Runs ONLY on a real
// macOS host: it launches the production Code Mode harness and a hostile probe
// harness under `sandbox-exec` with the exact profile the adapter generates, and
// records whether Node starts, runs a guest script over the node_ipc transport,
// and is denied host reads/writes/network. It also re-runs everything with a
// candidate narrowed profile (no `/bin` + `/sbin`) so the next narrowing step is
// decided by evidence rather than guesswork.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CODE_MODE_CHILD_SOURCE } from "./services/code-mode-child-source.js";
import { defaultCommandResolver } from "./services/code-mode-sandbox/command-resolution.js";
import { DarwinSeatbeltSandboxAdapter } from "./services/code-mode-sandbox/darwin-seatbelt-adapter.js";
import type { CodeModeSandboxLaunchSpec } from "./services/code-mode-sandbox/types.js";

const LAUNCH_TIMEOUT_MS = 20_000;
const BIN_SBIN_GRANT = ' (subpath "/bin") (subpath "/sbin")';
const HOST_SECRET_ENV_KEY = "GOATCITADEL_SEATBELT_PROOF_HOST_SECRET";

type ProfileVariant = "shipped" | "without_bin_sbin";

interface CliOptions {
  output: string;
  nodePath: string;
  label: string;
}

interface LaunchResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  messages: unknown[];
}

interface ScenarioResult {
  variant: ProfileVariant;
  harness: "production" | "hostile_probe";
  passed: boolean;
  failures: string[];
  detail: Record<string, unknown>;
}

const PROBE_HARNESS_SOURCE = String.raw`import fs from "node:fs";
import net from "node:net";
const [outsideSecretPath, outsideWriteDir, homeDir] = process.argv.slice(2);
function outcome(fn) {
  try {
    fn();
    return "allowed";
  } catch (error) {
    return error && typeof error.code === "string" ? error.code : "error";
  }
}
function connect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve("timeout");
    }, 3000);
    socket.on("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve("allowed");
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      resolve(typeof error.code === "string" ? error.code : "error");
    });
  });
}
const report = {
  cwd: process.cwd(),
  envKeys: Object.keys(process.env).sort(),
  insideWrite: outcome(() => fs.writeFileSync("probe-inside.txt", "ok")),
  outsideSecretRead: outcome(() => fs.readFileSync(outsideSecretPath, "utf8")),
  outsideWrite: outcome(() => fs.writeFileSync(outsideWriteDir + "/probe-outside.txt", "x")),
  homeList: outcome(() => fs.readdirSync(homeDir)),
  libraryKeychainsList: outcome(() => fs.readdirSync("/Library/Keychains")),
  libraryList: outcome(() => fs.readdirSync("/Library")),
  usrLocalList: outcome(() => fs.readdirSync("/usr/local")),
  etcRead: outcome(() => fs.readFileSync("/private/etc/hosts", "utf8")),
  network: await connect("1.1.1.1", 443),
};
process.send(report, () => process.disconnect());
`;

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("code-mode-seatbelt-live-proof only runs on macOS (sandbox-exec is required).");
  }
  const options = parseCliOptions(args);
  const nodePath = await fs.realpath(options.nodePath);
  process.env[HOST_SECRET_ENV_KEY] = "host-secret-must-not-reach-the-sandbox";

  const scenarios: ScenarioResult[] = [];
  for (const variant of ["shipped", "without_bin_sbin"] as const) {
    scenarios.push(await runProductionHarness(variant, nodePath));
    scenarios.push(await runHostileProbe(variant, nodePath));
  }

  const shippedPassed = scenarios.filter((s) => s.variant === "shipped").every((s) => s.passed);
  const narrowedPassed = scenarios.filter((s) => s.variant === "without_bin_sbin").every((s) => s.passed);
  const proof = {
    label: options.label,
    nodePath,
    nodeVersion: process.version,
    osRelease: os.release(),
    arch: process.arch,
    shippedProfilePassed: shippedPassed,
    withoutBinSbinPassed: narrowedPassed,
    scenarios,
  };
  await fs.mkdir(path.dirname(options.output), { recursive: true });
  await fs.writeFile(options.output, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
  if (!shippedPassed) {
    throw new Error("The shipped Seatbelt profile failed the live macOS proof; see scenarios above.");
  }
}

export function parseCliOptions(args: string[]): CliOptions {
  const read = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const output = read("--output");
  if (!output) {
    throw new Error("--output <path> is required.");
  }
  return {
    output: path.resolve(output),
    nodePath: read("--node-path") ?? process.execPath,
    label: read("--label") ?? "default",
  };
}

async function runProductionHarness(variant: ProfileVariant, nodePath: string): Promise<ScenarioResult> {
  return withRunRoot(async (runTempRoot) => {
    const harnessPath = path.join(runTempRoot, "code-mode-harness.mjs");
    await fs.writeFile(harnessPath, CODE_MODE_CHILD_SOURCE, "utf8");
    const launch = await prepareVariantLaunch(variant, { runTempRoot, harnessPath, nodePath, extraArgs: [] });
    const result = await runLaunch(launch, {
      jsonrpc: "2.0",
      id: "seatbelt-proof-run",
      method: "run.execute",
      params: {
        runId: "seatbelt-proof-run",
        source: "return { answer: input.a + input.b };",
        input: { a: 40, b: 2 },
        wrapperManifest: { wrappers: [] },
      },
    });
    const response = result.messages.find(
      (message): message is { id: string; result?: { answer?: number }; error?: unknown } =>
        isRecord(message) && message.id === "seatbelt-proof-run",
    );
    const failures: string[] = [];
    if (!response) failures.push("harness never answered run.execute over node_ipc");
    else if (response.error) failures.push(`harness returned error: ${JSON.stringify(response.error)}`);
    else if (response.result?.answer !== 42) failures.push(`unexpected result: ${JSON.stringify(response.result)}`);
    return {
      variant,
      harness: "production",
      passed: failures.length === 0,
      failures,
      detail: launchDetail(result),
    };
  });
}

async function runHostileProbe(variant: ProfileVariant, nodePath: string): Promise<ScenarioResult> {
  return withRunRoot(async (runTempRoot) => {
    const hostDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-seatbelt-host-")));
    try {
      const outsideSecretPath = path.join(hostDir, "host-secret.txt");
      await fs.writeFile(outsideSecretPath, "host secret", "utf8");
      const harnessPath = path.join(runTempRoot, "hostile-probe.mjs");
      await fs.writeFile(harnessPath, PROBE_HARNESS_SOURCE, "utf8");
      const launch = await prepareVariantLaunch(variant, {
        runTempRoot,
        harnessPath,
        nodePath,
        extraArgs: [outsideSecretPath, hostDir, os.homedir()],
      });
      const result = await runLaunch(launch);
      const report = result.messages.find(isRecord);
      const failures = report ? evaluateProbe(report, runTempRoot, nodePath) : ["probe harness never reported"];
      const outsideWriteLanded = await fs
        .access(path.join(hostDir, "probe-outside.txt"))
        .then(() => true)
        .catch(() => false);
      if (outsideWriteLanded) failures.push("probe wrote a file outside the run root");
      return {
        variant,
        harness: "hostile_probe",
        passed: failures.length === 0,
        failures,
        detail: { ...launchDetail(result), report },
      };
    } finally {
      await fs.rm(hostDir, { recursive: true, force: true });
    }
  });
}

function evaluateProbe(report: Record<string, unknown>, runTempRoot: string, nodePath: string): string[] {
  const failures: string[] = [];
  const denied = (key: string) => {
    if (report[key] === "allowed") failures.push(`${key} was allowed`);
  };
  if (report.insideWrite !== "allowed") failures.push(`insideWrite was ${String(report.insideWrite)}`);
  if (typeof report.cwd === "string" && path.resolve(report.cwd) !== path.resolve(runTempRoot)) {
    failures.push(`cwd ${report.cwd} is not the run root`);
  }
  denied("outsideSecretRead");
  denied("outsideWrite");
  denied("homeList");
  denied("libraryKeychainsList");
  denied("libraryList");
  denied("etcRead");
  if (report.network !== "EPERM" && report.network !== "EACCES") {
    failures.push(`network was ${String(report.network)} (expected EPERM)`);
  }
  // A Node living under /usr/local is granted that prefix on purpose.
  if (!nodePath.startsWith("/usr/local/")) denied("usrLocalList");
  const envKeys = Array.isArray(report.envKeys) ? report.envKeys : [];
  if (envKeys.includes(HOST_SECRET_ENV_KEY)) failures.push("host secret env key reached the sandbox");
  return failures;
}

async function prepareVariantLaunch(
  variant: ProfileVariant,
  input: { runTempRoot: string; harnessPath: string; nodePath: string; extraArgs: string[] },
): Promise<CodeModeSandboxLaunchSpec> {
  const adapter = new DarwinSeatbeltSandboxAdapter({
    platform: "darwin",
    resolveCommand: defaultCommandResolver,
    osRelease: os.release(),
  });
  const launch = await adapter.prepareLaunch({
    runId: "seatbelt-proof",
    nodePath: input.nodePath,
    harnessPath: input.harnessPath,
    runTempRoot: input.runTempRoot,
    heapMb: 128,
    env: { GOATCITADEL_CODE_MODE: "1", TZ: "UTC" },
  });
  if (variant === "without_bin_sbin") {
    const profilePath = launch.generatedArtifacts[0];
    if (!profilePath) throw new Error("Seatbelt adapter did not report its generated profile.");
    const profile = await fs.readFile(profilePath, "utf8");
    if (!profile.includes(BIN_SBIN_GRANT)) {
      throw new Error("Shipped profile no longer carries the /bin + /sbin grant; update this proof.");
    }
    await fs.writeFile(profilePath, profile.replace(BIN_SBIN_GRANT, ""), "utf8");
  }
  return { ...launch, args: [...launch.args, ...input.extraArgs] };
}

async function withRunRoot<T>(fn: (runTempRoot: string) => Promise<T>): Promise<T> {
  // Deliberately NOT realpath'd: os.tmpdir() is under the /var -> /private/var
  // symlink, which the adapter must canonicalize for Seatbelt to match.
  const runTempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-seatbelt-run-"));
  try {
    return await fn(runTempRoot);
  } finally {
    await fs.rm(runTempRoot, { recursive: true, force: true });
  }
}

function runLaunch(launch: CodeModeSandboxLaunchSpec, firstMessage?: unknown): Promise<LaunchResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.executable, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const messages: unknown[] = [];
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), LAUNCH_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("message", (message) => messages.push(message));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, messages });
    });
    if (firstMessage !== undefined) {
      // A child that dies at startup fails the send; the scenario reports that
      // through the missing response, so the send error itself is not fatal.
      child.send(firstMessage as Parameters<typeof child.send>[0], () => undefined);
    }
  });
}

function launchDetail(result: LaunchResult): Record<string, unknown> {
  return {
    exitCode: result.code,
    signal: result.signal,
    stdout: result.stdout.slice(0, 2000),
    stderr: result.stderr.slice(0, 2000),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
}
