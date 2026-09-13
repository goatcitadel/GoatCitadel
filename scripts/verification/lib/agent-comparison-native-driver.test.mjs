import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { sha256 } from "./agent-comparison.mjs";
import {
  bindNativeComparisonConfig,
  buildNativeComparisonProfile,
  nativeComparisonArguments,
  NATIVE_COMPARISON_PINS,
  NATIVE_PROFILE_SLOTS,
} from "./agent-comparison-native-profile.mjs";
import {
  assertNativeComparisonCheckoutHasNoLocalSecrets,
  nativeComparisonEnvironment,
  superviseNativeComparisonProcess,
  readNativeComparisonGit,
  initializeNativeComparisonWorkspace,
} from "./agent-comparison-native-driver.mjs";

it("rejects ignored checkout dotenv files without loading or modifying them", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "goat-native-driver-env-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assertNativeComparisonCheckoutHasNoLocalSecrets(directory);
  await writeFile(path.join(directory, ".env"), "FAKE_PROVIDER_KEY=fixture-only\n");
  await assert.rejects(assertNativeComparisonCheckoutHasNoLocalSecrets(directory), /dedicated native checkout/);
});

it("keeps the Hermes interactive launch explicit and preserves its native tool and approval policy", () => {
  const profile = {
    revision: NATIVE_COMPARISON_PINS.hermes,
    model: "fixture",
    provider: "comparison",
    tools: ["files", "terminal"],
    grants: ["test-workspace"],
    reasoning: "none",
    contextTokens: 64000,
    outputTokens: 1024,
    maxTaskMs: 30000,
  };
  const headless = buildNativeComparisonProfile("hermes", profile);
  const interactive = buildNativeComparisonProfile("hermes", profile, "max_completion_tokens", {
    interactiveCli: true,
  });
  assert.deepEqual(interactive.config, headless.config);
  assert.notEqual(interactive.planSha256, headless.planSha256);
  assert.equal(interactive.interactiveCli, true);
  const args = nativeComparisonArguments("hermes", {
    profile,
    promptFile: "/fixture/prompt.txt",
    interactiveCli: true,
  });
  assert.equal(args.includes("--quiet"), false);
  assert.equal(args.includes("--oneshot"), false);
  assert.equal(args.includes("--yolo"), false);
  assert.equal(args[args.indexOf("--toolsets") + 1], "file,terminal");
  assert.throws(
    () => buildNativeComparisonProfile("goatcitadel", profile, "max_tokens", { interactiveCli: true }),
    /only for pinned Hermes/,
  );
  assert.throws(() => superviseNativeComparisonProcess({ inheritOutput: true }), /requires interactive input/);
});

it("initializes only the new native fixture repository using isolated Git configuration", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "goat-native-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"),
    homeDirectory = path.join(root, "home");
  await mkdir(workspace);
  await mkdir(homeDirectory);
  const git = await readNativeComparisonGit();
  assert.match(git.sha256, /^[a-f0-9]{64}$/u);
  const environment = nativeComparisonEnvironment({
    product: "goatcitadel",
    homeDirectory,
    stateDirectory: homeDirectory,
    checkoutRoot: root,
    executablePath: process.execPath,
    proxyKey: "controlled",
    toolGitPath: git.executablePath,
  });
  assert.equal(environment.GIT_CONFIG_NOSYSTEM, "1");
  assert.ok(environment.PATH.split(path.delimiter).includes(path.dirname(git.executablePath)));
  const args = { workspace, homeDirectory, gitExecutablePath: git.executablePath, environment };
  assert.deepEqual(await initializeNativeComparisonWorkspace(args), {
    workspace,
    initialized: true,
    commitsCreated: 0,
    stagedFiles: 0,
  });
  assert.match(await readFile(path.join(workspace, ".git", "HEAD"), "utf8"), /^ref: refs\/heads\/comparison/u);
  await assert.rejects(readFile(path.join(workspace, ".git", "index")), { code: "ENOENT" });
  await assert.rejects(initializeNativeComparisonWorkspace(args), /already has Git metadata/);
});

it("stops its native process if the operator output channel fails", async (t) => {
  const child = superviseNativeComparisonProcess({
    executablePath: process.execPath,
    args: ["-e", "setInterval(()=>process.stdout.write('controlled'),10)"],
    cwd: os.tmpdir(),
    environment: process.env,
    onOutput: () => {
      throw new Error("fixture output unavailable");
    },
  });
  t.after(() => child.stop("fixture_close"));
  assert.equal((await child.finished).stopReason, "output_forwarding_failed");
});

const profile = (product) => ({
  revision: NATIVE_COMPARISON_PINS[product],
  provider: "fixture",
  model: "fixture-model",
  tools: ["files", "terminal"],
  grants: ["test-workspace"],
  reasoning: "none",
  contextTokens: product === "hermes" ? 64_000 : 8192,
  outputTokens: 256,
  maxTaskMs: 30_000,
});

it("rejects a Hermes context window its pinned runtime cannot start", () => {
  assert.throws(
    () => buildNativeComparisonProfile("hermes", { ...profile("hermes"), contextTokens: 32_768 }),
    /at least 64,000/,
  );
});

it("prepares source-pinned profiles with explicit native permission differences and no ambient credentials", () => {
  for (const product of ["openclaw", "hermes"]) {
    const config = profile(product);
    const plan = buildNativeComparisonProfile(product, config);
    assert.equal(plan.revision, NATIVE_COMPARISON_PINS[product]);
    assert.equal(
      plan.effectiveConfigSha256,
      sha256({
        provider: config.provider,
        model: config.model,
        tools: config.tools,
        grants: config.grants,
        reasoning: config.reasoning,
        contextTokens: config.contextTokens,
        outputTokens: config.outputTokens,
        maxTaskMs: config.maxTaskMs,
      }),
    );
    assert.equal(plan.taskOutcome, "unverified");
    assert.match(JSON.stringify(plan.config), new RegExp(NATIVE_PROFILE_SLOTS.apiKey));
    assert.doesNotMatch(JSON.stringify(plan.config), /anthropic|openrouter|yolo/iu);
  }
  const claw = buildNativeComparisonProfile("openclaw", profile("openclaw"));
  assert.equal(claw.config.tools.exec.mode, "ask");
  assert.deepEqual(claw.config.tools.exec.safeBins, []);
  assert.equal(claw.permissionPolicy.terminal, "allowlist_miss_approval");
  assert.equal(claw.permissionPolicy.files, "workspace_only");
  assert.equal(claw.config.tools.fs.workspaceOnly, true);
  assert.deepEqual(claw.config.agents.defaults.model.fallbacks, []);
  assert.deepEqual(claw.config.agents.defaults.skills, []);
  assert.deepEqual(claw.config.skills.workshop, { autonomous: { mode: "off" }, approvalPolicy: "pending" });
  assert.equal(claw.config.models.providers.comparison.models[0].compat.maxTokensField, "max_completion_tokens");
  const hermes = buildNativeComparisonProfile("hermes", profile("hermes"), "max_tokens");
  assert.equal(hermes.config.approvals.mode, "manual");
  assert.equal(hermes.config.approvals.single_query_mode, "deny");
  assert.equal(hermes.permissionPolicy.terminal, "risk_based_approval");
  assert.equal(hermes.permissionPolicy.files, "host_user");
  assert.deepEqual(hermes.config.fallback_providers, []);
  assert.deepEqual(hermes.config.providers.comparison.extra_body, { max_tokens: 256 });
});

it("rejects unreviewed revisions, untranslatable grants/tools, and invalid output policy", () => {
  for (const overrides of [
    { revision: "a".repeat(40) },
    { grants: ["all-host"] },
    { tools: ["skills"] },
    { outputTokens: profile("hermes").contextTokens + 1 },
    { model: "--untrusted-option" },
  ])
    assert.throws(() => buildNativeComparisonProfile("hermes", { ...profile("hermes"), ...overrides }));
  assert.throws(() => buildNativeComparisonProfile("hermes", profile("hermes"), "arbitrary"));
  assert.throws(() => buildNativeComparisonProfile("unknown", profile("hermes")), /supports only/);
});

it("binds only exact typed proxy slots and the matching campaign identity", () => {
  const plan = buildNativeComparisonProfile("openclaw", profile("openclaw"));
  const connection = {
    revision: plan.revision,
    effectiveConfigSha256: plan.effectiveConfigSha256,
    baseUrl: "http://127.0.0.1:12345/v1",
    apiKey: "a".repeat(64),
  };
  const workspace = path.resolve("literal $()` workspace");
  const bound = bindNativeComparisonConfig(plan, connection, workspace);
  assert.equal(bound.agents.defaults.workspace, workspace);
  assert.equal(bound.models.providers.comparison.apiKey, connection.apiKey);
  assert.equal(bound.gateway.port, 12345);
  assert.equal(bound.gateway.auth.token, connection.apiKey);
  assert.equal(plan.config.agents.defaults.workspace, NATIVE_PROFILE_SLOTS.workspace);
  for (const baseUrl of [
    "https://external.invalid/v1",
    "http://localhost:12345/v1",
    "http://127.0.0.1:12345/v1?redirect=1",
  ])
    assert.throws(() => bindNativeComparisonConfig(plan, { ...connection, baseUrl }, workspace));
  assert.throws(() => bindNativeComparisonConfig(plan, { ...connection, revision: "b".repeat(40) }, workspace));
});

it("keeps shell-significant prompt paths as separate arguments and never enables automatic approvals", () => {
  for (const product of ["openclaw", "hermes"]) {
    const promptFile = path.resolve("query $(whoami) `literal` & file.txt");
    const args = nativeComparisonArguments(product, {
      checkoutRoot: path.resolve("source"),
      configFile: path.resolve("config.json"),
      stateDirectory: path.resolve("state"),
      promptFile,
      workspace: path.resolve("workspace"),
      profile: profile(product),
    });
    assert.ok(args.includes(promptFile));
    assert.ok(!args.includes("--oneshot") && !args.includes("--yolo") && !args.includes("--auth-env-only"));
    if (product === "hermes") assert.equal(args[args.indexOf("--run-budget") + 1], "30");
  }
});

it("drops ambient secrets, preload hooks, proxy settings, and personal PATH entries", () => {
  const env = nativeComparisonEnvironment({
    product: "hermes",
    homeDirectory: path.resolve("fresh-home"),
    stateDirectory: path.resolve("fresh-home/state"),
    executablePath: process.execPath,
    checkoutRoot: path.resolve("source"),
    proxyKey: "short-lived-fixture",
    ambient: {
      OPENAI_API_KEY: "personal-secret",
      anthropic_api_key: "personal-secret",
      NODE_OPTIONS: "--require=private.js",
      PYTHONPATH: "private",
      HTTP_PROXY: "private",
      PATH: "private-binaries",
      HOME: "personal-home",
      SystemRoot: "C:\\Windows",
    },
  });
  const bytes = JSON.stringify(env);
  assert.doesNotMatch(bytes, /personal-secret|private|personal-home/);
  assert.equal(env.OPENAI_API_KEY, "short-lived-fixture");
  assert.equal(env.PYTHONPATH, path.resolve("source"));
  assert.equal(env.HOME, path.resolve("fresh-home"));
});

it("supervises an actual process with bounded output and preserves an argument verbatim", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "goat-native-driver-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const literal = "quotes ' \" ` $() & are data";
  const child = superviseNativeComparisonProcess({
    executablePath: process.execPath,
    args: ["-e", "process.stdout.write(process.argv[1]);process.stderr.write('diagnostic')", literal],
    cwd: directory,
    environment: { ...process.env, NODE_OPTIONS: "" },
  });
  t.after(() => child.stop("test_cleanup"));
  const result = await child.finished;
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, literal);
  assert.equal(result.stderr, "diagnostic");
  assert.equal(result.stopReason, "process_exit");
});

it("terminates its owned process on abort and on output overflow", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "goat-native-driver-stop-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  const child = superviseNativeComparisonProcess({
    executablePath: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: directory,
    environment: process.env,
    signal: controller.signal,
  });
  t.after(() => child.stop("test_cleanup"));
  controller.abort();
  assert.equal((await child.finished).stopReason, "operator_abort");
  const deadline = new AbortController();
  const expired = superviseNativeComparisonProcess({
    executablePath: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: directory,
    environment: process.env,
    signal: deadline.signal,
  });
  t.after(() => expired.stop("test_cleanup"));
  deadline.abort("deadline");
  assert.equal((await expired.finished).stopReason, "deadline");
  const noisy = superviseNativeComparisonProcess({
    executablePath: process.execPath,
    args: ["-e", "setInterval(()=>process.stdout.write('x'.repeat(4096)),5)"],
    cwd: directory,
    environment: process.env,
    maxOutputBytes: 128,
  });
  t.after(() => noisy.stop("test_cleanup"));
  const result = await noisy.finished;
  assert.equal(result.stopReason, "output_limit");
  assert.equal(result.stdout.length, 128);
});

it("does not claim a naturally exited parent's descendants were stopped", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "goat-native-driver-pipes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = superviseNativeComparisonProcess({
    executablePath: process.execPath,
    args: [
      "-e",
      "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]}); console.log(child.pid); child.unref();",
    ],
    cwd: directory,
    environment: process.env,
  });
  t.after(() => child.stop("test_cleanup"));
  const result = await child.finished;
  // This fixture's fixed program emits the PID of its one owned child. The
  // production supervisor never kills a PID obtained from product output.
  const ownedFixturePid = Number(result.stdout.trim());
  if (Number.isSafeInteger(ownedFixturePid) && ownedFixturePid > 0) {
    try {
      process.kill(ownedFixturePid);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  assert.ok(Number.isSafeInteger(ownedFixturePid) && ownedFixturePid > 0);
  assert.equal(result.descendantsStopped, "not_verified");
  if (process.platform === "win32") {
    assert.equal(result.stopReason, "process_exit");
  } else {
    assert.equal(result.stopReason, "inherited_stdio_unclosed");
    assert.equal(result.cleanupUnconfirmed, true);
  }
});
