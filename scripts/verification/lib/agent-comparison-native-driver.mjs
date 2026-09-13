import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { sha256, summarizeComparison } from "./agent-comparison.mjs";
import { readComparisonJson, startComparisonSession } from "./agent-comparison-session.mjs";
import { PERMISSION_REVIEW_FILE, PERMISSION_REVIEW_VERSION } from "./agent-comparison-permissions.mjs";
import { assertNativeApprovalTerminal } from "./agent-comparison-native-approval-console.mjs";
import { readHermesNativeTranscript } from "./agent-comparison-hermes-transcript.mjs";
import { readNativeComparisonWorkflowEvidence } from "./agent-comparison-goat-evidence.mjs";
import {
  callNativeOpenclawApproval,
  startNativeOpenclawApprovalGateway,
  startNativeOpenclawApprovalReviewer,
  validateNativeOpenclawDecision,
} from "./agent-comparison-openclaw-gateway.mjs";
import {
  bindNativeComparisonConfig,
  buildNativeComparisonProfile,
  nativeComparisonArguments,
  NATIVE_COMPARISON_VERSION,
} from "./agent-comparison-native-profile.mjs";

const execute = promisify(execFile);
const MAX_PROCESS_OUTPUT = 8 * 1024 * 1024;

export async function readNativeComparisonGit() {
  const locator =
    process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "where.exe") : "which";
  const result = await execute(locator, ["git"], { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 });
  const executablePath = await ordinaryPath(result.stdout.trim().split(/\r?\n/u)[0], "file");
  if (/\.(cmd|bat|ps1|sh)$/iu.test(executablePath))
    throw new Error("Native project identity requires a Git executable, not a shell wrapper.");
  return { executablePath, sha256: await fileSha256(executablePath) };
}

export async function initializeNativeComparisonWorkspace({
  workspace,
  homeDirectory,
  gitExecutablePath,
  environment,
  signal,
}) {
  const root = await ordinaryPath(workspace, "directory");
  try {
    await lstat(path.join(root, ".git"));
    throw new Error("The fresh comparison workspace already has Git metadata.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const template = path.join(homeDirectory, "empty-git-template");
  await mkdir(template);
  await execute(
    gitExecutablePath,
    ["-c", "init.defaultBranch=comparison", "init", "--quiet", `--template=${template}`, root],
    { cwd: root, env: environment, windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024, signal },
  );
  const top = await execute(gitExecutablePath, ["-C", root, "rev-parse", "--show-toplevel"], {
    cwd: root,
    env: environment,
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 64 * 1024,
    signal,
  });
  const normalize = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  if (normalize(await ordinaryPath(top.stdout.trim(), "directory")) !== normalize(root))
    throw new Error("The native fixture Git root changed.");
  return { workspace: root, initialized: true, commitsCreated: 0, stagedFiles: 0 };
}

export async function readNativeComparisonCheckout(checkoutRoot) {
  const root = await ordinaryPath(checkoutRoot, "directory");
  const git = async (args) =>
    (
      await execute("git", ["-C", root, ...args], {
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      })
    ).stdout;
  return {
    revision: (await git(["rev-parse", "HEAD"])).trim(),
    clean:
      (await git(["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--untracked-files=normal"])).length === 0,
  };
}

export async function prepareNativeComparisonLaunch({
  manifest,
  cellId,
  checkoutRoot,
  executablePath,
  approvalGateway = false,
  interactiveCli = false,
  skillWorkflow = false,
}) {
  summarizeComparison(manifest, []);
  const cell = manifest.cells.find((entry) => `${entry.product}:${entry.task}:${entry.trial}` === cellId);
  if (!cell) throw new Error("Select one declared comparison cell.");
  const profile = manifest.products[cell.product];
  const nativeProfile = buildNativeComparisonProfile(cell.product, profile, manifest.transportProfile?.outputField, {
    approvalGateway,
    interactiveCli,
    skillWorkflow,
  });
  if (!nativeProfile.supportedTasks.includes(cell.task))
    throw new Error("Use the supervised workflow for this task; it requires native review or delivery actions.");
  const checkout = await readNativeComparisonCheckout(checkoutRoot);
  await assertNativeComparisonCheckoutHasNoLocalSecrets(checkoutRoot);
  if (!checkout.clean || checkout.revision !== profile.revision)
    throw new Error("The native product checkout must be clean and match its reviewed source revision.");
  const executable = await ordinaryPath(executablePath, "file");
  if (/\.(cmd|bat|ps1|sh)$/iu.test(executable))
    throw new Error("Use the native Node/Python executable, not a shell wrapper.");
  const git = cell.product === "goatcitadel" ? await readNativeComparisonGit() : null;
  const plan = {
    schemaVersion: NATIVE_COMPARISON_VERSION,
    manifestSha256: manifest.manifestSha256,
    cellId,
    checkoutRoot: await realpath(checkoutRoot),
    executablePath: executable,
    executableSha256: await fileSha256(executable),
    toolNodePath: await ordinaryPath(process.execPath, "file"),
    toolNodeSha256: await fileSha256(process.execPath),
    ...(cell.product === "goatcitadel"
      ? {
          gatewayAppSha256: await fileSha256(
            await ordinaryPath(path.join(checkoutRoot, "apps/gateway/dist/app.js"), "file"),
          ),
          toolGitPath: git.executablePath,
          toolGitSha256: git.sha256,
          driverFiles: await Promise.all(
            [
              "agent-comparison-goat-child.mjs",
              "agent-comparison-goat-api.mjs",
              "agent-comparison-goat-client.mjs",
              "agent-comparison-goat-workflow.mjs",
              "agent-comparison-workflow.mjs",
              "agent-comparison-native-approval-console.mjs",
            ].map(async (name) => ({
              name,
              sha256: await fileSha256(fileURLToPath(new URL(name, import.meta.url))),
            })),
          ),
        }
      : {}),
    ...(approvalGateway
      ? {
          driverFiles: await Promise.all(
            [
              "agent-comparison-native-driver.mjs",
              "agent-comparison-native-profile.mjs",
              "agent-comparison-native-approval-console.mjs",
              ...(cell.product === "openclaw"
                ? [
                    "agent-comparison-openclaw-gateway.mjs",
                    "agent-comparison-openclaw-reviewer.mjs",
                    ...(skillWorkflow
                      ? [
                          "agent-comparison-openclaw-workflow-child.mjs",
                          "agent-comparison-openclaw-workflow.mjs",
                          "agent-comparison-workflow.mjs",
                          "agent-comparison-goat-evidence.mjs",
                        ]
                      : []),
                  ]
                : [
                    "agent-comparison-goat-child.mjs",
                    "agent-comparison-goat-api.mjs",
                    "agent-comparison-goat-client.mjs",
                    "agent-comparison-goat-workflow.mjs",
                    "agent-comparison-workflow.mjs",
                    "agent-comparison-goat-profile.mjs",
                  ]),
            ].map(async (name) => ({ name, sha256: await fileSha256(fileURLToPath(new URL(name, import.meta.url))) })),
          ),
        }
      : {}),
    ...(interactiveCli
      ? {
          driverFiles: await Promise.all(
            [
              "agent-comparison-native-driver.mjs",
              "agent-comparison-native-profile.mjs",
              "agent-comparison-hermes-transcript.mjs",
              ...(skillWorkflow
                ? [
                    "agent-comparison-hermes-workflow.mjs",
                    "agent-comparison-hermes-workflow-child.mjs",
                    "agent-comparison-workflow.mjs",
                    "agent-comparison-native-approval-console.mjs",
                    "agent-comparison-goat-evidence.mjs",
                  ]
                : []),
            ].map(async (name) => ({ name, sha256: await fileSha256(fileURLToPath(new URL(name, import.meta.url))) })),
          ),
        }
      : {}),
    nativeProfile,
    isolation: "fresh_profile_and_environment_not_os_sandbox",
    approvalBehavior: "reviewed_native_policy_no_supervisor_approval",
  };
  return { ...plan, launchSha256: sha256(plan) };
}

/** Keep ambient provider/auth/plugin variables out, including case variants on
 * Windows. The runtime and OS paths are explicit, and every home/cache is fresh.
 * This prevents accidental credential inheritance; it cannot jail a host tool. */
export function nativeComparisonEnvironment({
  product,
  homeDirectory,
  stateDirectory,
  executablePath,
  checkoutRoot,
  proxyKey,
  toolNodePath = process.execPath,
  toolGitPath,
  ambient = process.env,
}) {
  const environment = {};
  const inherited = new Set([
    "systemroot",
    "windir",
    "comspec",
    "os",
    "number_of_processors",
    "processor_architecture",
    "pathext",
  ]);
  for (const [key, value] of Object.entries(ambient))
    if (inherited.has(key.toLowerCase()) && typeof value === "string") environment[key] = value;
  const systemRoot = Object.entries(environment).find(([key]) => key.toLowerCase() === "systemroot")?.[1];
  environment.PATH = [
    ...new Set([
      path.dirname(toolNodePath),
      path.dirname(executablePath),
      ...(toolGitPath ? [path.dirname(toolGitPath)] : []),
      ...(process.platform === "win32" && systemRoot
        ? [path.join(systemRoot, "System32"), systemRoot]
        : ["/usr/bin", "/bin"]),
    ]),
  ].join(path.delimiter);
  Object.assign(environment, {
    HOME: homeDirectory,
    USERPROFILE: homeDirectory,
    APPDATA: path.join(homeDirectory, "appdata"),
    LOCALAPPDATA: path.join(homeDirectory, "localappdata"),
    XDG_CONFIG_HOME: path.join(homeDirectory, "config"),
    XDG_DATA_HOME: path.join(homeDirectory, "data"),
    XDG_CACHE_HOME: path.join(homeDirectory, "cache"),
    TMP: path.join(homeDirectory, "tmp"),
    TEMP: path.join(homeDirectory, "tmp"),
    TMPDIR: path.join(homeDirectory, "tmp"),
    NO_COLOR: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONUTF8: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(homeDirectory, "git-config"),
  });
  if (product === "openclaw") environment.OPENCLAW_STATE_DIR = stateDirectory;
  else if (product === "hermes") {
    environment.HERMES_HOME = stateDirectory;
    environment.PYTHONPATH = checkoutRoot;
    // Only the proxy token may satisfy a custom-provider auxiliary fallback.
    environment.OPENAI_API_KEY = proxyKey;
  } else if (product === "goatcitadel") {
    Object.assign(environment, {
      GOATCITADEL_ROOT_DIR: stateDirectory,
      GOATCITADEL_DATABASE_DRIVER: "sqlite",
      GOATCITADEL_DISABLE_SECRET_STORE: "true",
      GOATCITADEL_COMPARISON_PROXY_KEY: proxyKey,
      GOATCITADEL_AUTH_MODE: "token",
      GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS: "false",
      GOATCITADEL_LOG_LEVEL: "warn",
      GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS: "false",
    });
  } else throw new Error("Unsupported native process environment.");
  return environment;
}

export async function runNativeComparison({
  manifest,
  campaignDirectory,
  outputDirectory,
  options,
  launch,
  review,
  upstreamApiKey,
  signal,
  fetchUpstream,
  onApprovalReady,
  onNativeOutput,
  evidenceSource = "native_receipts",
}) {
  if (!["native_receipts", "controlled_fixture"].includes(evidenceSource))
    throw new Error("Declare a supported native or controlled comparison evidence source.");
  const childReviewConsole =
    options.nativeApprovalGateway === true &&
    (options.cellId?.startsWith("goatcitadel:") || options.nativeSkillWorkflow === true);
  const hermesInteractive = options.nativeInteractiveCli === true;
  if (childReviewConsole || hermesInteractive) {
    assertNativeApprovalTerminal();
    if (typeof onNativeOutput !== "function")
      throw new Error("The native interactive process requires visible output.");
  }
  if (options.nativeApprovalGateway === true && !childReviewConsole && typeof onApprovalReady !== "function")
    throw new Error("The reviewed native approval Gateway requires an attached operator console.");
  // Reconstruct from source/runtime bytes immediately before starting. Reviewing
  // a file and subsequently changing the checkout, binary, policy, or caps fails.
  const current = await prepareNativeComparisonLaunch({
    manifest,
    cellId: options.cellId,
    checkoutRoot: options.checkoutRoot,
    executablePath: launch.executablePath,
    approvalGateway: options.nativeApprovalGateway ?? false,
    interactiveCli: options.nativeInteractiveCli ?? false,
    skillWorkflow: options.nativeSkillWorkflow ?? false,
  });
  if (
    sha256(current) !== sha256(launch) ||
    review?.schemaVersion !== NATIVE_COMPARISON_VERSION ||
    review.launchSha256 !== current.launchSha256 ||
    review.effectiveConfigSha256 !== current.nativeProfile.effectiveConfigSha256 ||
    review.nativePolicyReviewed !== true ||
    review.credentialIsolationReviewed !== true ||
    Object.keys(review).some(
      (key) =>
        ![
          "schemaVersion",
          "launchSha256",
          "effectiveConfigSha256",
          "nativePolicyReviewed",
          "credentialIsolationReviewed",
          "reviewedBy",
          "reviewedAt",
        ].includes(key),
    ) ||
    typeof review.reviewedBy !== "string" ||
    !review.reviewedBy.trim() ||
    review.reviewedBy.length > 200 ||
    !Number.isFinite(Date.parse(review.reviewedAt))
  )
    throw new Error(
      "Retain operator review of this exact launch, native policy, and credential isolation before dispatch.",
    );
  signal?.throwIfAborted();
  const session = await startComparisonSession({
    manifest,
    campaignDirectory,
    outputDirectory,
    options,
    upstreamApiKey,
    checkout: { revision: current.nativeProfile.revision, clean: true },
    evidenceSource,
    ...(fetchUpstream ? { fetchUpstream } : {}),
  });
  const runtimeStop = new AbortController();
  const runtimeSignal = AbortSignal.any([runtimeStop.signal, ...(signal ? [signal] : [])]);
  void session.finished.then(({ ok, result }) =>
    runtimeStop.abort(ok && result.reason === "deadline" ? "deadline" : "transport_closed"),
  );
  let child, gateway, reviewer, approvalConsole;
  const approvalReceipts = [];
  try {
    const connection = await readComparisonJson(session.connectionFile);
    const profile = manifest.products[current.nativeProfile.product];
    const homeDirectory = path.join(outputDirectory, "native-home");
    const stateDirectory = path.join(homeDirectory, "state");
    for (const directory of [
      homeDirectory,
      stateDirectory,
      ...["tmp", "appdata", "localappdata", "config", "data", "cache"].map((name) => path.join(homeDirectory, name)),
    ])
      await mkdir(directory);
    const configFile = path.join(stateDirectory, current.nativeProfile.filename);
    if (path.dirname(configFile) !== stateDirectory) await mkdir(path.dirname(configFile));
    let environment = nativeComparisonEnvironment({
      product: current.nativeProfile.product,
      homeDirectory,
      stateDirectory,
      executablePath: current.executablePath,
      checkoutRoot: current.checkoutRoot,
      proxyKey: connection.apiKey,
      toolNodePath: current.toolNodePath,
      toolGitPath: current.toolGitPath,
    });
    if (current.nativeProfile.product === "goatcitadel") {
      await writeNativeComparisonJson(
        path.join(session.evidence, "native-workspace-git.json"),
        await initializeNativeComparisonWorkspace({
          workspace: session.workspace,
          homeDirectory,
          gitExecutablePath: current.toolGitPath,
          environment,
          signal: runtimeSignal,
        }),
      );
      approvalReceipts.push("native-workspace-git.json");
    }
    if (current.nativeProfile.approvalGateway && current.nativeProfile.product === "openclaw") {
      gateway = await startNativeOpenclawApprovalGateway({
        plan: current.nativeProfile,
        connection,
        workspace: session.workspace,
        configFile,
        environment,
        checkoutRoot: current.checkoutRoot,
        executablePath: current.executablePath,
        signal: runtimeSignal,
        superviseProcess: superviseNativeComparisonProcess,
      });
      environment = gateway.environment;
      await writeNativeComparisonJson(path.join(session.evidence, "native-approval-gateway.json"), {
        ...gateway.evidence,
        ...session.binding,
        launchSha256: current.launchSha256,
      });
      approvalReceipts.push("native-approval-gateway.json");
      reviewer = await startNativeOpenclawApprovalReviewer({
        control: gateway.control,
        outputFile: path.join(session.evidence, "native-approval-events.jsonl"),
        signal: runtimeSignal,
        superviseProcess: superviseNativeComparisonProcess,
      });
      approvalReceipts.push("native-approval-events.jsonl");
      if (!current.nativeProfile.skillWorkflow)
        approvalConsole = await onApprovalReady({
          workspace: session.workspace,
          signal: runtimeSignal,
          onClosed: () => runtimeStop.abort("operator_console_closed"),
          pending: () => callNativeOpenclawApproval(gateway.control, "pending", {}, runtimeSignal),
          resolve: async (input) => {
            runtimeSignal.throwIfAborted();
            validateNativeOpenclawDecision(input);
            const actionId = randomUUID();
            const intent = {
              ...session.binding,
              actionId,
              source: "operator_console",
              approvalId: input.approvalId,
              decision: input.decision,
              requestedAt: new Date().toISOString(),
            };
            const intentFile = `native-approval-${actionId}-intent.json`;
            await writeNativeComparisonJson(path.join(session.evidence, intentFile), intent);
            approvalReceipts.push(intentFile);
            let outcome;
            try {
              outcome = {
                status: "native_response",
                result: await callNativeOpenclawApproval(gateway.control, "resolve", input, runtimeSignal),
              };
            } catch (error) {
              outcome = { status: "unconfirmed", error: gateway.redact(error.message) };
            }
            const resultFile = `native-approval-${actionId}-result.json`;
            await writeNativeComparisonJson(path.join(session.evidence, resultFile), {
              ...intent,
              ...outcome,
              finishedAt: new Date().toISOString(),
            });
            approvalReceipts.push(resultFile);
            if (outcome.status === "unconfirmed") throw new Error(outcome.error);
            return outcome.result;
          },
        });
      if (!current.nativeProfile.skillWorkflow && typeof approvalConsole?.stop !== "function")
        throw new Error("The native approval console must retain a close handle.");
    } else {
      await writeNativeComparisonJson(
        configFile,
        bindNativeComparisonConfig(current.nativeProfile, connection, session.workspace),
      );
    }
    if (current.nativeProfile.product === "goatcitadel") {
      await writeNativeComparisonJson(path.join(stateDirectory, "config", "llm-model-metadata.json"), {
        version: 1,
        entries: {
          [`comparison/${profile.model}`]: {
            contextWindow: profile.contextTokens,
            outputTokenLimit: profile.outputTokens,
            reasoning: { supportedEfforts: [profile.reasoning] },
          },
        },
      });
      // Stop dotenv discovery at this fresh root, without copying another file.
      const envFile = await open(path.join(stateDirectory, ".env"), "wx", 0o600);
      await envFile.close();
    }
    await writeNativeComparisonJson(path.join(session.evidence, "native-launch.json"), {
      ...current,
      review,
      ...session.binding,
    });
    await writeNativeComparisonJson(path.join(session.evidence, PERMISSION_REVIEW_FILE), {
      schemaVersion: PERMISSION_REVIEW_VERSION,
      ...session.binding,
      policy: current.nativeProfile.permissionPolicy,
      reviewedBy: review.reviewedBy,
      reviewedAt: review.reviewedAt,
      sourceReceipts: [
        { path: "native-launch.json", sha256: await fileSha256(path.join(session.evidence, "native-launch.json")) },
      ],
    });
    const args = nativeComparisonArguments(current.nativeProfile.product, {
      checkoutRoot: current.checkoutRoot,
      configFile,
      stateDirectory,
      promptFile: session.promptFile,
      workspace: session.workspace,
      profile,
      evidenceDirectory: session.evidence,
      approvalGateway: current.nativeProfile.approvalGateway ?? false,
      interactiveCli: current.nativeProfile.interactiveCli ?? false,
      skillWorkflow: current.nativeProfile.skillWorkflow ?? false,
      configurationSha256: gateway?.control.configurationSha256 ?? sha256(await readComparisonJson(configFile)),
      executablePath: current.executablePath,
    });
    runtimeSignal.throwIfAborted();
    child = superviseNativeComparisonProcess({
      executablePath:
        current.nativeProfile.product === "hermes" && current.nativeProfile.skillWorkflow
          ? current.toolNodePath
          : current.executablePath,
      args,
      cwd: session.workspace,
      environment,
      signal: runtimeSignal,
      ...(childReviewConsole ? { interactiveInput: true, onOutput: onNativeOutput } : {}),
      ...(hermesInteractive ? { interactiveInput: true, inheritOutput: true, onOutput: onNativeOutput } : {}),
    });
    const first = await Promise.race([
      child.finished.then((result) => ({ kind: "process", result })),
      session.finished.then(() => ({ kind: "transport_closed" })),
      ...(gateway ? [gateway.finished.then(() => ({ kind: "approval_gateway_closed" }))] : []),
      ...(reviewer ? [reviewer.finished.then(() => ({ kind: "approval_reviewer_closed" }))] : []),
    ]);
    if (first.kind !== "process") await child.stop(first.kind);
    const result = await child.finished;
    runtimeStop.abort("native_process_finished");
    await approvalConsole?.stop();
    await reviewer?.stop("native_process_finished");
    await gateway?.stop("native_process_finished");
    const redact = gateway?.redact ?? ((value) => value.replaceAll(connection.apiKey, "[supervised proxy token]"));
    if (gateway) {
      const nativeOwnerResult = await gateway.finished;
      const nativeReviewerResult = await reviewer.finished;
      await writeNativeComparisonJson(
        path.join(session.evidence, "native-approval-processes.json"),
        JSON.parse(
          redact(
            JSON.stringify({
              ...session.binding,
              gateway: nativeOwnerResult,
              reviewer: nativeReviewerResult,
            }),
          ),
        ),
      );
      approvalReceipts.push("native-approval-processes.json");
    }
    const outputs = { stdout: redact(result.stdout), stderr: redact(result.stderr) };
    await writeNativeComparisonJson(path.join(session.evidence, "native-output.json"), outputs);
    const receipt = {
      schemaVersion: NATIVE_COMPARISON_VERSION,
      ...session.binding,
      launchSha256: current.launchSha256,
      source: "native_process",
      exitCode: result.exitCode,
      signal: result.signal,
      stopReason: result.stopReason,
      cleanupUnconfirmed: result.cleanupUnconfirmed,
      descendantsStopped: result.descendantsStopped,
      durationMs: result.durationMs,
      outputSha256: sha256(outputs),
      taskOutcome: "unverified",
      manualInterventions: null,
      ...(hermesInteractive
        ? { stdoutCapture: "not_captured_native_terminal", transcriptSource: "native_session_database" }
        : {}),
      note: "Process exit and transport completion do not establish task success or zero operator interventions.",
    };
    await writeNativeComparisonJson(path.join(session.evidence, "native-process.json"), receipt);
    if (hermesInteractive) {
      const transcript = await readHermesNativeTranscript({ stateDirectory });
      await writeNativeComparisonJson(
        path.join(session.evidence, "native-hermes-transcript.json"),
        JSON.parse(redact(JSON.stringify({ ...session.binding, ...transcript }))),
      );
      approvalReceipts.push("native-hermes-transcript.json");
    }
    const nativeReceipts = await Promise.all(
      [
        "native-launch.json",
        "native-output.json",
        "native-process.json",
        PERMISSION_REVIEW_FILE,
        ...approvalReceipts,
      ].map(async (name) => ({
        path: name,
        sha256: await fileSha256(path.join(session.evidence, name)),
      })),
    );
    let workflow, nativeSnapshotCount;
    if (current.nativeProfile.skillWorkflow && result.exitCode === 0 && result.stopReason === "process_exit") {
      const retained = await readNativeComparisonWorkflowEvidence({
        product: current.nativeProfile.product,
        evidenceDirectory: session.evidence,
        binding: session.binding,
        source: evidenceSource,
        // Normal native shutdown aborts runtimeSignal above. Final evidence
        // still honors operator cancellation, independently of process cleanup.
        signal,
      });
      for (const reference of retained.nativeReceipts) {
        const existing = nativeReceipts.find((entry) => entry.path === reference.path);
        if (existing && existing.sha256 !== reference.sha256)
          throw new Error("The native skill workflow evidence changed during campaign assembly.");
        if (!existing) nativeReceipts.push(reference);
      }
      workflow = retained.workflow;
      nativeSnapshotCount = retained.nativeSnapshotCount;
    } else if (current.nativeProfile.product === "goatcitadel") {
      let entries = [];
      try {
        entries = await readdir(await ordinaryPath(path.join(session.evidence, "goatcitadel"), "directory"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (entries.length > 600) throw new Error("The native Gateway receipt inventory exceeds its bound.");
      const receiptName =
        /^(?:workspace|project|session|route-preflight|agent-send|thread|thread-final|interrupted|(?:approvals|durable|thread|approval-replay)-\d{4}|approval-[a-f0-9-]{36}-(?:intent|result|unconfirmed))\.json$/u;
      for (const name of entries.sort()) {
        if (
          !receiptName.test(name) &&
          !(current.nativeProfile.skillWorkflow && /^workflow-\d{4}-[a-z0-9-]{1,120}\.json$/u.test(name))
        )
          throw new Error("Unexpected file in native Gateway evidence.");
        const relative = `goatcitadel/${name}`;
        try {
          const filename = await ordinaryPath(path.join(session.evidence, relative), "file");
          if ((await lstat(filename)).size > 4 * 1024 * 1024)
            throw new Error("Native Gateway evidence exceeds the bound.");
          nativeReceipts.push({ path: relative, sha256: await fileSha256(filename) });
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
    // Native phase evidence feeds the independent verifier; process success
    // alone never becomes an outcome grade.
    await writeNativeComparisonJson(path.join(session.evidence, "execution.json"), {
      schemaVersion: "goatcitadel.agent-comparison.execution.v1",
      ...session.binding,
      product: current.nativeProfile.product,
      taskId: options.cellId.split(":")[1],
      source: evidenceSource,
      nativeReceipts,
      ...(workflow ? { workflow, nativeSnapshotCount } : {}),
    });
    const transport = await session.close();
    return { receipt, transport, evidenceDirectory: session.evidence };
  } finally {
    // Stop only the process started above; never signal an existing product.
    runtimeStop.abort("supervisor_close");
    try {
      await child?.stop("supervisor_close");
    } finally {
      try {
        await approvalConsole?.stop();
      } finally {
        try {
          await reviewer?.stop("supervisor_close");
        } finally {
          try {
            await gateway?.stop("supervisor_close");
          } finally {
            await session.close();
          }
        }
      }
    }
  }
}

export function superviseNativeComparisonProcess({
  executablePath,
  args,
  cwd,
  environment,
  signal,
  maxOutputBytes = MAX_PROCESS_OUTPUT,
  interactiveInput = false,
  inheritOutput = false,
  onOutput,
}) {
  signal?.throwIfAborted();
  if (inheritOutput && !interactiveInput) throw new Error("Native terminal output requires interactive input.");
  if (interactiveInput) {
    assertNativeApprovalTerminal();
    if (typeof onOutput !== "function") throw new Error("Interactive native input requires visible output.");
  }
  const startedAt = performance.now();
  const child = spawn(executablePath, args, {
    cwd,
    env: environment,
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: [interactiveInput ? "inherit" : "ignore", inheritOutput ? "inherit" : "pipe", "pipe"],
  });
  const stdout = [],
    stderr = [];
  let outputBytes = 0,
    settled = false,
    stopReason = null,
    stopPromise;
  let rootExited = false,
    cleanupUnconfirmed = false,
    drainTimer;
  let resolveFinished;
  const finished = new Promise((resolve) => {
    resolveFinished = resolve;
  });
  const onAbort = () => {
    const reason = [
      "deadline",
      "transport_closed",
      "operator_console_closed",
      "native_process_finished",
      "supervisor_close",
    ].includes(signal?.reason)
      ? signal.reason
      : "operator_abort";
    void stop(reason);
  };
  const capture = (destination, chunk) => {
    const available = Math.max(0, maxOutputBytes - outputBytes);
    outputBytes += chunk.length;
    if (available) {
      const retained = chunk.subarray(0, available);
      destination.push(retained);
      if (onOutput) {
        try {
          onOutput(retained);
        } catch {
          void stop("output_forwarding_failed");
        }
      }
    }
    if (outputBytes > maxOutputBytes) void stop("output_limit");
  };
  child.stdout?.on("data", (chunk) => capture(stdout, chunk));
  child.stderr.on("data", (chunk) => capture(stderr, chunk));
  const settle = (exitCode, processSignal, spawnError) => {
    if (settled) return;
    settled = true;
    clearTimeout(drainTimer);
    signal?.removeEventListener("abort", onAbort);
    resolveFinished({
      exitCode,
      signal: processSignal,
      stopReason: stopReason ?? (spawnError ? "spawn_failed" : "process_exit"),
      cleanupUnconfirmed,
      descendantsStopped: "not_verified",
      durationMs: Math.round(performance.now() - startedAt),
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: spawnError
        ? "The reviewed native executable could not be started."
        : Buffer.concat(stderr).toString("utf8"),
    });
  };
  child.once("error", (error) => settle(null, null, error));
  child.once("exit", (code, processSignal) => {
    rootExited = true;
    // An escaped child can retain these pipe handles after the direct child
    // exits. Do not hang the budget owner or signal a potentially recycled PID.
    drainTimer = setTimeout(() => {
      if (settled) return;
      cleanupUnconfirmed = true;
      stopReason = "inherited_stdio_unclosed";
      child.stdout?.destroy();
      child.stderr.destroy();
      settle(code, processSignal);
    }, 1_000);
  });
  child.once("close", (code, processSignal) => settle(code, processSignal));
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  async function stop(reason) {
    if (settled) return;
    if (stopPromise) return stopPromise;
    stopReason = reason;
    stopPromise = (async () => {
      if (child.pid && !rootExited) {
        if (process.platform === "win32") {
          // Absolute OS tool; never interpolate a command or enumerate unrelated PIDs.
          const root = process.env.SystemRoot ?? "C:/Windows";
          try {
            await execute(path.join(root, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], {
              windowsHide: true,
              timeout: 10_000,
            });
          } catch {
            if (!settled) child.kill();
          }
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") child.kill("SIGKILL");
          }
        }
      }
      const deadline = setTimeout(() => {
        if (settled) return;
        cleanupUnconfirmed = true;
        stopReason = "cleanup_unconfirmed";
        child.stdout?.destroy();
        child.stderr.destroy();
        settle(child.exitCode, child.signalCode);
      }, 2_000);
      try {
        await finished;
      } finally {
        clearTimeout(deadline);
      }
    })();
    return stopPromise;
  }
  return { pid: child.pid, finished, stop };
}

export async function writeNativeComparisonJson(filename, value) {
  const file = await open(filename, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function assertNativeComparisonCheckoutHasNoLocalSecrets(checkoutRoot) {
  // Hermes run_agent.py explicitly offers checkout/.env to its env loader.
  // Git's clean status ignores it, and a fresh HOME alone does not exclude it.
  // Inspect names/metadata only; never read or copy the operator's credentials.
  for (const name of [".env", ".env.local"]) {
    try {
      await lstat(path.join(checkoutRoot, name));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error("Use a dedicated native checkout without local .env credentials; existing files are preserved.");
  }
}

async function ordinaryPath(filename, kind) {
  if (!path.isAbsolute(filename ?? "")) throw new Error("Use an absolute native checkout/executable path.");
  const stat = await lstat(filename);
  if (stat.isSymbolicLink() || (kind === "file" ? !stat.isFile() : !stat.isDirectory()))
    throw new Error("Native checkout/executable paths must be ordinary files or directories.");
  const resolved = await realpath(filename);
  const normalize = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  if (normalize(path.resolve(filename)) !== normalize(resolved))
    throw new Error("Use a canonical native path without linked ancestors.");
  return resolved;
}
async function fileSha256(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}
