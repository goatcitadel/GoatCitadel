import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { readComparisonJson, startComparisonSession } from "./lib/agent-comparison-session.mjs";

const [manifestFile, optionsFile, outputDirectory, ...extra] = process.argv.slice(2);
if (!manifestFile || !optionsFile || !outputDirectory || extra.length)
  throw new Error("Usage: node scripts/verification/agent-comparison-serve.mjs MANIFEST OPTIONS NEW_CELL_DIRECTORY");

const options = await readComparisonJson(path.resolve(optionsFile));
const manifest = await readComparisonJson(path.resolve(manifestFile));
if (typeof options.checkoutRoot !== "string" || !path.isAbsolute(options.checkoutRoot))
  throw new Error("A product checkout's absolute path is required.");
const execute = promisify(execFile);
const git = (args) =>
  execute("git", ["-C", options.checkoutRoot, ...args], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    // Source checks must not invoke a configured external diff or fsmonitor hook.
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
const revision = (await git(["rev-parse", "HEAD"])).stdout.trim();
const status = (await git(["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--untracked-files=normal"]))
  .stdout;
const session = await startComparisonSession({
  manifest,
  campaignDirectory: path.dirname(path.resolve(manifestFile)),
  outputDirectory: path.resolve(outputDirectory),
  options,
  upstreamApiKey: process.env[options.apiKeyEnv],
  checkout: { revision, clean: status.length === 0 },
});
process.stdout.write(
  `Supervised cell ${session.binding.cellId} is ready. No provider request has been made by setup.\n`,
);
process.stdout.write(`Configure only an isolated test profile from ${session.connectionFile}\n`);
process.stdout.write(
  `Task input: ${session.promptFile}\nWorkspace: ${session.workspace}\nNative evidence: ${session.evidence}\n`,
);
process.stdout.write(
  "Review the product's effective configuration, credentials, tools, and approval posture before sending the task. Stop its work, then press Ctrl+C to close this cell and export its budget.\n",
);
const stop = () => {
  void session.close().catch(() => {});
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const outcome = await session.finished;
process.removeListener("SIGINT", stop);
process.removeListener("SIGTERM", stop);
if (!outcome.ok) {
  process.stderr.write(outcome.error + "\n");
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Transport closed: ${outcome.result.reason}; ${outcome.result.requests} provider attempts. Task results still require independent verification.\n`,
  );
  if (outcome.result.status === "unsettled_provider_cost") process.exitCode = 1;
}
