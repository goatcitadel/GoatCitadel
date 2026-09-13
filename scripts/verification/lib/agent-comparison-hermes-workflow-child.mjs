import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./agent-comparison.mjs";
import { readComparisonJson } from "./agent-comparison-session.mjs";
import { NATIVE_COMPARISON_PINS } from "./agent-comparison-native-profile.mjs";
import { superviseNativeComparisonProcess } from "./agent-comparison-native-driver.mjs";
import { createNativeComparisonReviewConsole } from "./agent-comparison-native-approval-console.mjs";
import { readHermesNativeTranscript } from "./agent-comparison-hermes-transcript.mjs";
import {
  executeHermesComparisonSkillWorkflow,
  readHermesComparisonSkillState,
} from "./agent-comparison-hermes-workflow.mjs";

const [checkoutRoot, python, configFile, configurationSha256, workspace, evidenceDirectory] = process.argv.slice(2);
if (
  process.argv.length !== 8 ||
  ![checkoutRoot, python, configFile, workspace, evidenceDirectory].every(path.isAbsolute) ||
  !process.stdin.isTTY ||
  !process.stdout.isTTY ||
  path.resolve(workspace) !== process.cwd() ||
  path.dirname(configFile) !== process.env.HERMES_HOME ||
  !/^[a-f0-9]{64}$/u.test(configurationSha256 ?? "")
)
  throw new Error("Invalid supervised Hermes workflow launch.");
const config = await readComparisonJson(configFile);
const start = await readComparisonJson(path.join(evidenceDirectory, "session-start.json"));
if (
  sha256(config) !== configurationSha256 ||
  start.revision !== NATIVE_COMPARISON_PINS.hermes ||
  path.dirname(workspace) !== path.dirname(evidenceDirectory) ||
  config.skills?.write_approval !== true ||
  config.skills.ledger !== true ||
  config.skills.project_discovery !== false ||
  config.skills.inline_shell !== false ||
  config.skills.template_vars !== false ||
  config.skills.external_dirs?.length !== 0 ||
  config.curator?.enabled !== false ||
  sha256(config.toolsets) !== sha256(["file", "skills"])
)
  throw new Error("The Hermes workflow config, source pin, or scope changed.");
const controller = new AbortController();
const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(start.profile.maxTaskMs)]);
const interrupt = () => controller.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const redact = (value) => String(value).replaceAll(config.providers.comparison.api_key, "[supervised proxy token]");
const stateDirectory = path.dirname(configFile);
const rawDirectory = path.join(evidenceDirectory, "hermes");
await mkdir(rawDirectory);
const retain = async (name, value) => {
  const bytes = redact(JSON.stringify(value, null, 2)) + "\n";
  if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) throw new Error("Hermes workflow evidence exceeds its byte bound.");
  const file = await open(path.join(rawDirectory, `${name}.json`), "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
};
let reviews,
  processOwner,
  promptSequence = 0;
const launch = async (args, interactive = false) => {
  signal.throwIfAborted();
  if (sha256(await readComparisonJson(configFile)) !== configurationSha256)
    throw new Error("The reviewed Hermes configuration changed between native processes.");
  processOwner = superviseNativeComparisonProcess({
    executablePath: python,
    args,
    cwd: workspace,
    environment: process.env,
    signal,
    ...(interactive ? { interactiveInput: true, inheritOutput: true } : {}),
    onOutput: (chunk) => process.stdout.write(redact(chunk.toString("utf8"))),
  });
  try {
    return JSON.parse(redact(JSON.stringify(await processOwner.finished)));
  } finally {
    processOwner = undefined;
  }
};
const turnArgs = (sessionId) => [
  "-m",
  "hermes_cli.main",
  "chat",
  "--provider",
  "comparison",
  "--model",
  start.profile.model,
  "--reasoning",
  start.profile.reasoning,
  "--toolsets",
  "file,skills",
  "--max-turns",
  "100",
  "--run-budget",
  String(start.profile.maxTaskMs / 1000),
  ...(sessionId ? ["--resume", sessionId] : []),
];
try {
  const result = await executeHermesComparisonSkillWorkflow({
    workspace,
    stateDirectory,
    cellDirectory: path.dirname(workspace),
    profile: start.profile,
    retain,
    signal,
    onReview: (material) => {
      reviews ??= createNativeComparisonReviewConsole({ signal });
      return reviews.review(material);
    },
    snapshot: async () => {
      if (sha256(await readComparisonJson(configFile)) !== configurationSha256)
        throw new Error("The reviewed Hermes configuration changed during native execution.");
      return {
        skills: await readHermesComparisonSkillState(stateDirectory),
        transcript: await readHermesNativeTranscript({ stateDirectory }),
      };
    },
    run: async (request) => {
      if (request.action === "bootstrap") {
        const optedOut = await launch(["-m", "hermes_cli.main", "skills", "opt-out"]);
        if (optedOut.exitCode !== 0 || optedOut.stopReason !== "process_exit" || optedOut.cleanupUnconfirmed)
          return optedOut;
        // Public native startup owner: sync only Hermes's mandatory operating
        // manual after the native operator command disables optional bundles.
        const seeded = await launch([
          "-c",
          "import json; from tools.skills_sync import sync_skills; print(json.dumps(sync_skills(quiet=True)))",
        ]);
        const marker = await readFile(path.join(stateDirectory, ".no-bundled-skills"), "utf8");
        return { ...seeded, bootstrap: { optedOut, marker, nativeOwner: "tools.skills_sync.sync_skills" } };
      }
      if (request.action === "review") {
        reviews?.stop();
        reviews = undefined;
        process.stdin.pause();
        process.stdout.write(
          `\nThe native Hermes CLI now owns the terminal. Run these native commands:\n/skills pending\n/skills diff ${request.pendingId}\n/skills approve ${request.pendingId}\n/exit\nDo not send a model prompt. Cancelling or rejecting leaves the reuse input withheld.\n`,
        );
        const outcome = await launch(turnArgs(request.sessionId), true);
        return { ...outcome, stdoutCapture: "not_captured_native_terminal", nativeReview: "cli_slash_commands" };
      }
      if (request.action !== "turn") throw new Error("Unsupported native Hermes workflow action.");
      const filename = path.join(evidenceDirectory, `hermes-prompt-${++promptSequence}.txt`);
      const file = await open(filename, "wx", 0o600);
      try {
        await file.writeFile(request.prompt + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
      return launch([...turnArgs(request.sessionId), "--query-file", filename, "--quiet"]);
    },
  });
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  process.stderr.write(redact(error.stack ?? error.message) + "\n");
  process.exitCode = signal.aborted || error.name === "AbortError" ? 130 : 1;
} finally {
  reviews?.stop();
  await processOwner?.stop("supervisor_close");
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
