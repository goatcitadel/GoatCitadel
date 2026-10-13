import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { sha256 } from "./agent-comparison.mjs";
import { readComparisonJson } from "./agent-comparison-session.mjs";
import {
  buildFeatureAcceptanceProfile,
  readFeatureAcceptanceAvailability,
} from "./agent-comparison-acceptance-profile.mjs";
import { bindNativeComparisonConfig, nativeComparisonArguments } from "./agent-comparison-native-profile.mjs";
import {
  assertNativeComparisonCheckoutHasNoLocalSecrets,
  initializeNativeComparisonWorkspace,
  nativeComparisonEnvironment,
  readNativeComparisonCheckout,
  readNativeComparisonGit,
  superviseNativeComparisonProcess,
  writeNativeComparisonJson,
} from "./agent-comparison-native-driver.mjs";
import { startNativeOpenclawApprovalGateway } from "./agent-comparison-openclaw-gateway.mjs";
import { readHermesNativeTranscript } from "./agent-comparison-hermes-transcript.mjs";
import { createNativeComparisonReviewConsole } from "./agent-comparison-native-approval-console.mjs";
import { bindNativeRecoveryConfiguration } from "./agent-comparison-native-recovery-binding.mjs";

const check = (value, message) => {
  if (!value) throw new Error(message);
};
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/u.test(value);
const normalizePath = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
const samePath = (left, right) => normalizePath(path.resolve(left)) === normalizePath(path.resolve(right));

async function ordinaryFile(filename) {
  const target = path.resolve(filename),
    stat = await lstat(target);
  check(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      stat.size <= 128 * 1024 * 1024 &&
      samePath(await realpath(target), target),
    "A reviewed executable or driver must be an ordinary bounded file.",
  );
  return { path: target, sha256: sha256(await readFile(target)) };
}

/** Pin the entire comparison-module family, including imported helpers. A
 * digest of only the selected entry module would leave mutable authority code. */
export async function readAcceptanceDriverFingerprint() {
  const directory = fileURLToPath(new URL(".", import.meta.url));
  const names = (await readdir(directory)).filter((name) => /^agent-comparison.*\.mjs$/u.test(name)).sort();
  check(names.length > 0 && names.length <= 512, "The reviewed driver inventory exceeds its bound.");
  const files = [];
  let bytes = 0;
  for (const name of names) {
    const filename = path.join(directory, name),
      stat = await lstat(filename);
    check(
      stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 2 * 1024 * 1024,
      "Comparison driver files must be ordinary bounded modules.",
    );
    bytes += stat.size;
    check(bytes <= 64 * 1024 * 1024, "The driver family exceeds its aggregate byte bound.");
    files.push({ name, sha256: sha256(await readFile(filename)) });
  }
  return { files, sha256: sha256(files) };
}

/** Read-only preparation: no campaign state, process, credential or model call. */
export async function prepareFeatureAcceptanceLaunch({ manifest, options, executablePath }) {
  const [product, taskId] = options.cellId.split(":"),
    profile = manifest.products[product];
  const availability = readFeatureAcceptanceAvailability(product, taskId, profile);
  check(
    availability.status === "supported",
    `The declared native journey is ${availability.status}: ${availability.reason}`,
  );
  const checkout = await readNativeComparisonCheckout(options.checkoutRoot);
  check(
    checkout.clean && checkout.revision === profile.revision,
    "Review a clean checkout at the exact feature acceptance pin.",
  );
  await assertNativeComparisonCheckoutHasNoLocalSecrets(options.checkoutRoot);
  const executable = await ordinaryFile(executablePath);
  check(!/\.(cmd|bat|ps1|sh)$/iu.test(executable.path), "Use a native Node/Python executable, not a shell wrapper.");
  const nativeProfile = buildFeatureAcceptanceProfile(product, profile, taskId, options.outputField);
  const plan = {
    product,
    taskId,
    revision: profile.revision,
    checkoutRoot: await realpath(options.checkoutRoot),
    manifestSha256: manifest.manifestSha256,
    cellId: options.cellId,
    executable,
    toolNode: await ordinaryFile(process.execPath),
    drivers: await readAcceptanceDriverFingerprint(),
    nativeProfile,
    ...(product === "goatcitadel"
      ? {
          git: await readNativeComparisonGit(),
          builtEntrypoint: await ordinaryFile(path.join(options.checkoutRoot, "apps/gateway/dist/app.js")),
        }
      : {}),
    isolation: "fresh_profile_and_environment_not_os_sandbox",
  };
  return { ...plan, launchSha256: sha256(plan) };
}

/** The shipped supervisor owns only fresh processes/configuration and typed
 * human reviews. Native public APIs remain the action and receipt owners. */
export async function createAcceptanceSupervisor({
  session,
  manifest,
  options,
  settings,
  reviewConsoleFactory = createNativeComparisonReviewConsole,
}) {
  check(
    settings &&
      Object.keys(settings).every((key) =>
        ["executablePath", "expectedLaunchSha256", "operatorId", "schedule"].includes(key),
      ) &&
      identifier(settings.operatorId) &&
      /^[a-f0-9]{64}$/u.test(settings.expectedLaunchSha256 ?? ""),
    "Prepare and review an exact supervisor launch hash and operator identity; inline credentials are unsupported.",
  );
  const launch = await prepareFeatureAcceptanceLaunch({ manifest, options, executablePath: settings.executablePath });
  check(
    launch.launchSha256 === settings.expectedLaunchSha256 &&
      launch.revision === session.binding.revision &&
      launch.manifestSha256 === session.binding.manifestSha256,
    "The reviewed launch or session binding changed.",
  );
  const connection = await readComparisonJson(session.connectionFile);
  const abort = new AbortController(),
    signal = abort.signal;
  void session.finished.then(
    () => abort.abort("transport_closed"),
    () => abort.abort("transport_closed"),
  );
  const reviews = reviewConsoleFactory({ signal });
  const review = async (kind, material) => {
    signal.throwIfAborted();
    const digest = sha256(material);
    check(
      (await reviews.review({ kind, material, sha256: digest })) === digest,
      "The typed review did not match this exact action.",
    );
    return { actorKind: "human", actorId: settings.operatorId, reviewedAt: new Date().toISOString() };
  };
  let runtime,
    child,
    gateway,
    activeCommand,
    configHash,
    environment,
    recoveryRuntimeId,
    recoveryFixture,
    closed = false,
    started = false;
  const home = path.join(path.dirname(session.workspace), "native-home"),
    state = path.join(home, "state");
  const configFile = path.join(state, launch.nativeProfile.filename),
    authToken = randomBytes(32).toString("base64url");
  const stateId = randomUUID();
  const redact = (value) =>
    String(value).replaceAll(connection.apiKey, "[proxy credential]").replaceAll(authToken, "[operator credential]");
  const recheck = async () => {
    signal.throwIfAborted();
    check(!closed, "The owned supervisor is closed.");
    const current = await prepareFeatureAcceptanceLaunch({
      manifest,
      options,
      executablePath: settings.executablePath,
    });
    check(
      current.launchSha256 === launch.launchSha256,
      "Source, executable, profile or imported driver changed before dispatch/resume.",
    );
    if (configHash)
      check(sha256(await readComparisonJson(configFile)) === configHash, "The reviewed native configuration changed.");
  };
  const runProcess = async (executablePath, args, commandSignal = signal) => {
    await recheck();
    check(!activeCommand, "A native command is already running in this cell.");
    activeCommand = superviseNativeComparisonProcess({
      executablePath,
      args,
      cwd: session.workspace,
      environment,
      signal: AbortSignal.any([signal, commandSignal]),
      maxOutputBytes: 4 * 1024 * 1024,
    });
    try {
      const result = await activeCommand.finished;
      check(
        result.exitCode === 0 && !result.cleanupUnconfirmed,
        "The owned native command did not settle successfully with confirmed root cleanup.",
      );
      return JSON.parse(redact(JSON.stringify(result)));
    } finally {
      activeCommand = undefined;
    }
  };
  const stopOwned = async () => {
    await activeCommand?.stop("supervisor_close");
    await gateway?.stop("supervisor_close");
    await child?.stop("supervisor_close");
    const outcomes = await Promise.all([gateway?.finished, child?.finished]);
    check(
      outcomes.every((result) => !result?.cleanupUnconfirmed),
      "Owned process cleanup remains unconfirmed.",
    );
    gateway = child = undefined;
  };
  const startOwned = async () => {
    await recheck();
    const runtimeId = recoveryRuntimeId ?? randomUUID();
    if (launch.product === "openclaw") {
      gateway = await startNativeOpenclawApprovalGateway({
        plan: launch.nativeProfile,
        connection,
        workspace: session.workspace,
        configFile,
        environment,
        checkoutRoot: launch.checkoutRoot,
        executablePath: launch.executable.path,
        signal,
        superviseProcess: superviseNativeComparisonProcess,
        ...(recoveryFixture ? { recoveryFixture, deadlineAt: session.deadlineAt } : {}),
      });
      environment = gateway.environment;
      configHash = gateway.control.configurationSha256;
      runtime = {
        runtimeId,
        stateId,
        revision: launch.revision,
        workspace: session.workspace,
        configurationSha256: configHash,
      };
    } else if (launch.product === "goatcitadel") {
      const readyFile = path.join(state, `ready-${runtimeId}.json`);
      child = superviseNativeComparisonProcess({
        executablePath: launch.executable.path,
        args: [
          fileURLToPath(new URL("./agent-comparison-acceptance-goat-child.mjs", import.meta.url)),
          launch.checkoutRoot,
          state,
          readyFile,
        ],
        cwd: session.workspace,
        environment: { ...environment, GOATCITADEL_AUTH_TOKEN: authToken },
        signal,
      });
      const readySignal = AbortSignal.any([signal, AbortSignal.timeout(180000)]);
      for (;;) {
        readySignal.throwIfAborted();
        try {
          const ready = await readComparisonJson(readyFile),
            url = new URL(ready.baseUrl);
          check(
            url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port && !url.username && !url.password,
            "The owned Gateway returned an invalid loopback binding.",
          );
          runtime = {
            runtimeId,
            stateId,
            revision: launch.revision,
            workspace: session.workspace,
            configurationSha256: configHash,
            baseUrl: ready.baseUrl,
            token: authToken,
          };
          break;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        const stopped = await Promise.race([child.finished.then(() => true), delay(100).then(() => false)]);
        check(!stopped, "The owned Gateway stopped before becoming ready.");
      }
    } else
      runtime = {
        runtimeId,
        stateId,
        revision: launch.revision,
        workspace: session.workspace,
        configurationSha256: configHash,
      };
    if (!recoveryRuntimeId) session.acceptanceFaults?.bindRuntime(runtimeId);
    return runtime;
  };
  const api = async (route, body, method = body === undefined ? "GET" : "POST") => {
    check(launch.product === "goatcitadel" && runtime, "This public control requires the owned Goat Gateway.");
    const response = await fetch(
      new URL(`api/v1${route}`, runtime.baseUrl.endsWith("/") ? runtime.baseUrl : runtime.baseUrl + "/"),
      {
        method,
        headers: { authorization: `Bearer ${authToken}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      },
    );
    check(response.ok, `Native public setup failed at ${route} (${response.status}).`);
    return response.json();
  };
  return {
    async start({ taskId, revision, workspace, connectionFile }) {
      check(
        !started &&
          taskId === launch.taskId &&
          revision === launch.revision &&
          samePath(workspace, session.workspace) &&
          samePath(connectionFile, session.connectionFile),
        "The supervisor launch scope changed or was already started.",
      );
      await review("stage", {
        launchSha256: launch.launchSha256,
        nativeProfile: launch.nativeProfile,
        isolation: launch.isolation,
      });
      started = true;
      try {
        for (const directory of [
          home,
          state,
          ...["tmp", "appdata", "localappdata", "config", "data", "cache"].map((name) => path.join(home, name)),
        ])
          await mkdir(directory);
        environment = nativeComparisonEnvironment({
          product: launch.product,
          homeDirectory: home,
          stateDirectory: state,
          executablePath: launch.executable.path,
          checkoutRoot: launch.checkoutRoot,
          proxyKey: connection.apiKey,
          toolNodePath: launch.toolNode.path,
          toolGitPath: launch.git?.executablePath,
        });
        if (launch.taskId === "provider_recovery" && launch.product !== "goatcitadel") {
          check(
            session.acceptanceFaults && Number.isFinite(session.deadlineAt),
            "Use this cell's existing fault controls and deadline.",
          );
          recoveryRuntimeId = randomUUID();
          session.acceptanceFaults.bindRuntime(recoveryRuntimeId);
          const fixture = session.acceptanceFaults.getEffectConnection({ runtimeId: recoveryRuntimeId, signal });
          await review("confirm", {
            action: "configure exact isolated marker MCP and one metered fallback",
            url: fixture.url,
            markerEffect: "nonce recorded before a deliberately lost response",
            tools: "only the pinned marker alias; no terminal or ambient MCP servers",
          });
          recoveryFixture = session.acceptanceFaults.enableReviewedPublicTransport({
            runtimeId: recoveryRuntimeId,
            signal,
          });
        }
        if (launch.product !== "openclaw") {
          await mkdir(path.dirname(configFile), { recursive: true });
          let config = bindNativeComparisonConfig(launch.nativeProfile, connection, session.workspace);
          if (recoveryFixture)
            config = bindNativeRecoveryConfiguration({
              product: launch.product,
              revision: launch.revision,
              config,
              connection,
              fixture: recoveryFixture,
              deadlineAt: session.deadlineAt,
            });
          await writeNativeComparisonJson(configFile, config);
          configHash = sha256(await readComparisonJson(configFile));
        }
        if (launch.product === "goatcitadel") {
          await initializeNativeComparisonWorkspace({
            workspace: session.workspace,
            homeDirectory: home,
            gitExecutablePath: launch.git.executablePath,
            environment,
            signal,
          });
          const envFile = await open(path.join(state, ".env"), "wx", 0o600);
          await envFile.close();
          await writeNativeComparisonJson(path.join(state, "config/llm-model-metadata.json"), {
            version: 1,
            entries: {
              [`comparison/${manifest.products.goatcitadel.model}`]: {
                contextWindow: manifest.products.goatcitadel.contextTokens,
                outputTokenLimit: 4096,
                reasoning: { supportedEfforts: [manifest.products.goatcitadel.reasoning] },
              },
            },
          });
        }
        return await startOwned();
      } catch (error) {
        await stopOwned();
        throw error;
      }
    },
    async restart({ runtimeId, stateId: expectedState }) {
      check(
        runtime?.runtimeId === runtimeId && expectedState === stateId && launch.product === "goatcitadel",
        "Only this owned Goat runtime may restart its admitted state.",
      );
      await stopOwned();
      return startOwned();
    },
    async reviewPermissions({ configurationSha256 }) {
      await recheck();
      check(configurationSha256 === configHash, "Permission review configuration changed.");
      const decision = await review("confirm", {
        configurationSha256,
        policy: launch.nativeProfile.permissionPolicy,
        notes: launch.nativeProfile.reviewNotes,
      });
      return {
        configurationSha256,
        reviewedBy: decision.actorId,
        reviewedAt: decision.reviewedAt,
        policy: launch.nativeProfile.permissionPolicy,
      };
    },
    async reviewSources({ artifact, artifactSha256, tools }) {
      check(
        sha256(artifact) === artifactSha256 && Array.isArray(artifact.claims) && artifact.claims.length <= 100,
        "Source review requires this exact bounded artifact.",
      );
      const decision = await review("artifacts", { artifact, artifactSha256, tools });
      return {
        reviewerKind: "human",
        reviewerId: decision.actorId,
        artifactSha256,
        claims: artifact.claims.map((claim) => ({ claimId: claim.id, claimSha256: sha256(claim), supported: true })),
        conflicts: artifact.conflicts ?? [],
        conflictSearchCompleted: true,
      };
    },
    async runTurn({ prompt, signal: commandSignal }) {
      check(
        ["web_research", "provider_recovery"].includes(launch.taskId) &&
          ["openclaw", "hermes"].includes(launch.product),
        "Use the native public Goat adapter for Chat actions.",
      );
      const promptFile = path.join(state, `prompt-${randomUUID()}.txt`),
        outputFile = path.join(state, `turn-${randomUUID()}.json`);
      const file = await open(promptFile, "wx", 0o600);
      try {
        await file.writeFile(prompt);
      } finally {
        await file.close();
      }
      if (launch.product === "openclaw") {
        await runProcess(
          launch.executable.path,
          [
            fileURLToPath(new URL("./agent-comparison-acceptance-openclaw-child.mjs", import.meta.url)),
            launch.checkoutRoot,
            configFile,
            configHash,
            promptFile,
            outputFile,
          ],
          commandSignal,
        );
        return readComparisonJson(outputFile);
      }
      const process = await runProcess(
        launch.executable.path,
        nativeComparisonArguments("hermes", {
          checkoutRoot: launch.checkoutRoot,
          configFile,
          stateDirectory: state,
          promptFile,
          workspace: session.workspace,
          profile: {
            ...manifest.products.hermes,
            maxTaskMs: Math.max(1, Math.min(manifest.products.hermes.maxTaskMs, session.deadlineAt - Date.now())),
            tools: launch.taskId === "provider_recovery" ? ["files", "mcp-comparison-recovery"] : ["files", "web"],
          },
        }),
        commandSignal,
      );
      return { process, transcript: await readHermesNativeTranscript({ stateDirectory: state }) };
    },
    async approve({ approval }) {
      check(identifier(approval?.approvalId), "Review an exact native approval.");
      const decision = await review("confirm", { approval });
      return { ...decision, approvalId: approval.approvalId, decision: "approve" };
    },
    async authorizeSchedule() {
      const schedule = settings.schedule;
      check(
        schedule &&
          Object.keys(schedule).every((key) =>
            ["channelKey", "connectionId", "connection", "target", "schedule", "scheduledFor"].includes(key),
          ) &&
          identifier(schedule.channelKey) &&
          identifier(schedule.connectionId) !== Boolean(schedule.connection) &&
          typeof schedule.target === "string" &&
          schedule.target.length > 0 &&
          schedule.target.length <= 500 &&
          typeof schedule.schedule === "string" &&
          Number.isFinite(Date.parse(schedule.scheduledFor)) &&
          Date.parse(schedule.scheduledFor) > Date.now(),
        "Configure one authorized test destination and a future occurrence; never substitute an ambient channel.",
      );
      let connectionId = schedule.connectionId;
      if (schedule.connection) {
        const candidate = schedule.connection;
        check(
          launch.product === "goatcitadel" &&
            schedule.channelKey === "ntfy" &&
            Object.keys(candidate).every((key) => ["baseUrl", "topic"].includes(key)) &&
            candidate.topic === schedule.target,
          "Fresh channel setup supports only the reviewed credential-free loopback ntfy fixture.",
        );
        const url = new URL(candidate.baseUrl);
        check(
          url.protocol === "http:" &&
            url.hostname === "127.0.0.1" &&
            url.port &&
            !url.username &&
            !url.password &&
            url.pathname === "/" &&
            !url.search &&
            !url.hash,
          "Use an explicitly configured loopback test receiver.",
        );
        await review("confirm", { action: "create isolated ntfy connection", connection: candidate });
        const saved = await api("/integrations/connections", {
          catalogId: "channel.ntfy",
          enabled: true,
          label: "Reviewed comparison destination",
          config: candidate,
        });
        check(identifier(saved.connectionId), "The public connection owner returned no exact identity.");
        connectionId = saved.connectionId;
      }
      const decision = await review("confirm", { schedule });
      const { connection: _configuration, ...authorization } = schedule;
      return { ...decision, ...authorization, connectionId };
    },
    armPreDispatchFailure: (input) => session.acceptanceFaults.armPreDispatchFailure(input),
    observeProviderFault: (input) => session.acceptanceFaults.observeProviderFault(input),
    async armUncertainEffect(input) {
      await recheck();
      if (launch.product !== "goatcitadel") {
        check(
          launch.taskId === "provider_recovery" && input.runtimeId === runtime?.runtimeId && recoveryFixture,
          "Use the exact reviewed native recovery runtime.",
        );
        const toolName =
          launch.product === "openclaw"
            ? "comparison-recovery__record_marker"
            : "mcp__comparison_recovery__record_marker";
        await review("confirm", {
          fixture: "one nonce marker; loss of response requires independent observation",
          toolName,
        });
        session.acceptanceFaults.bindEffectTool({ ...input, toolName });
        return { ...session.acceptanceFaults.armUncertainEffect(input), aliasSource: "pinned_native_normalization" };
      }
      const connection = session.acceptanceFaults.getEffectConnection(input);
      await review("confirm", {
        fixture: "nonce-bound marker with intentionally lost response",
        url: connection.url,
        authority: "normal MCP policy and approval",
      });
      const transport = session.acceptanceFaults.enableReviewedPublicTransport(input);
      const server = await api("/mcp/servers", {
        label: "Controlled comparison marker",
        transport: "http",
        url: transport.url,
        authType: "none",
        enabled: true,
        policy: { requireFirstToolApproval: true, allowedToolPatterns: ["record_marker"] },
      });
      check(server.serverId, "The native MCP owner did not create a server identity.");
      await api(`/mcp/servers/${encodeURIComponent(server.serverId)}/connect`, {});
      const tools = await api(`/mcp/servers/${encodeURIComponent(server.serverId)}/tools`);
      check(
        tools.items?.length === 1 && tools.items[0].toolName === transport.nativeToolName,
        "The native MCP inventory does not contain the exact marker fixture tool.",
      );
      const toolName = `mcp.${server.serverId}.${transport.nativeToolName}`;
      session.acceptanceFaults.bindEffectTool({ ...input, toolName });
      return { ...session.acceptanceFaults.armUncertainEffect(input), mcpServerIds: [server.serverId] };
    },
    observeEffectTransport: (input) => session.acceptanceFaults.observeEffectTransport(input),
    async stop() {
      if (closed) return;
      closed = true;
      abort.abort("supervisor_close");
      try {
        await stopOwned();
      } finally {
        reviews.stop();
      }
    },
  };
}
