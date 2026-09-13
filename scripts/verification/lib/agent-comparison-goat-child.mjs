import { randomBytes } from "node:crypto";
import { mkdir, readFile, open } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { executeGoatComparisonTurn } from "./agent-comparison-goat-api.mjs";
import { executeGoatComparisonSkillWorkflow } from "./agent-comparison-goat-workflow.mjs";
import { PassThrough } from "node:stream";
import {
  startNativeApprovalConsole,
  createNativeComparisonReviewConsole,
} from "./agent-comparison-native-approval-console.mjs";

// The supervisor passes literal paths and a fresh environment. Import the built
// product only after binding the runtime root and its local environment file.
const [checkoutRoot, stateDirectory, promptFile, workspace, evidence, mode] = process.argv.slice(2);
const skillWorkflow = mode === "--supervised-skill-workflow";
const supervised = mode === "--supervised-approvals" || skillWorkflow;
if (
  !evidence ||
  (process.argv.length !== 7 && !(process.argv.length === 8 && supervised)) ||
  (supervised && !process.stdin.isTTY) ||
  path.resolve(stateDirectory) !== process.env.GOATCITADEL_ROOT_DIR ||
  path.resolve(workspace) !== process.cwd()
)
  throw new Error("GoatCitadel comparison launch binding is invalid.");
const config = JSON.parse(await readFile(path.join(stateDirectory, "config", "goatcitadel.json"), "utf8"));
process.env.GOATCITADEL_AUTH_TOKEN = randomBytes(32).toString("base64url");
const controller = new AbortController();
let interruptionReason;
const interrupt = (reason) => {
  interruptionReason ??= reason;
  controller.abort();
};
process.once("SIGTERM", () => interrupt("process_signal"));
process.once("SIGINT", () => interrupt("process_signal"));
const retain = async (name, value) => {
  const file = await open(path.join(evidence, `${name}.json`), "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
};
const { buildApp } = await import(pathToFileURL(path.join(checkoutRoot, "apps/gateway/dist/app.js")));
const app = await buildApp();
// The supervisor inherits a checked real terminal for input and forwards this
// bounded output pipe to that same operator terminal while retaining evidence.
const consoleOutput = new PassThrough();
consoleOutput.isTTY = true;
consoleOutput.columns = 100;
consoleOutput.pipe(process.stdout, { end: false });
let reviewConsole;
try {
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  await mkdir(evidence, { recursive: false });
  const execute = skillWorkflow ? executeGoatComparisonSkillWorkflow : executeGoatComparisonTurn;
  const result = await execute({
    baseUrl: `${address}/`,
    token: process.env.GOATCITADEL_AUTH_TOKEN,
    workspace,
    prompt: await readFile(promptFile, "utf8"),
    profile: { model: config.llm.activeModel, thinkingLevel: config.llm.defaultThinkingLevel },
    signal: controller.signal,
    ...(skillWorkflow
      ? {
          cellDirectory: path.dirname(path.dirname(evidence)),
          onReview: async (review) => {
            try {
              reviewConsole ??= createNativeComparisonReviewConsole({
                output: consoleOutput,
                signal: controller.signal,
              });
              return await reviewConsole.review(review);
            } catch (error) {
              if (error.name === "AbortError") interrupt("operator_review_closed");
              throw error;
            }
          },
        }
      : {}),
    ...(supervised
      ? {
          onApprovalReady: (control) => {
            reviewConsole?.stop();
            reviewConsole = undefined;
            return startNativeApprovalConsole({
              ...control,
              output: consoleOutput,
              onClosed: () => {
                interrupt("operator_console_closed");
                control.onClosed();
              },
            });
          },
        }
      : {}),
    retain,
  });
  process.stdout.write(JSON.stringify({ sessionId: result.sessionId, evidence, taskOutcome: "unverified" }) + "\n");
} catch (error) {
  if (!controller.signal.aborted || error.name !== "AbortError") throw error;
  await retain("interrupted", {
    status: "cancelled",
    reason: interruptionReason,
    observedAt: new Date().toISOString(),
    taskOutcome: "unverified",
  });
  process.exitCode = 130;
} finally {
  reviewConsole?.stop();
  consoleOutput.end();
  await app.close();
}
