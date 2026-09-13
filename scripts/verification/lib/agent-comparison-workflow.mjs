import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { COMPARISON_TASKS, sha256 } from "./agent-comparison.mjs";
import { readComparisonJson } from "./agent-comparison-session.mjs";
import { PERMISSION_REVIEW_FILE } from "./agent-comparison-permissions.mjs";

const VERSION = "goatcitadel.agent-comparison.workflow.v1";
const BINDING = ["executionId", "manifestSha256", "cellId", "revision", "effectiveConfigSha256", "fixtureSha256"];
const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** Supervised native journeys use the product's own UI/CLI for each turn and
 * approval. This controller retains native evidence and releases held-out input
 * only after exact-version review; it never approves a skill or sends a message.
 * A receipt filename is not authentication: source receipts must be retained by
 * the operator/adapter outside the agent's workspace. */
export async function advanceComparisonWorkflow({
  cellDirectory,
  action,
  receipt,
  instructions,
  executionFile = "execution.json",
}) {
  requireValue(
    ["execution.json", "workflow-execution.json"].includes(executionFile),
    "Use a declared workflow execution receipt.",
  );
  const root = await realpath(cellDirectory);
  requireValue(
    path.resolve(cellDirectory) === root && !(await lstat(cellDirectory)).isSymbolicLink(),
    "Use the canonical cell directory.",
  );
  const evidence = path.join(root, "evidence");
  const workspace = path.join(root, "workspace");
  for (const directory of [evidence, workspace])
    requireValue(
      (await realpath(directory)) === directory && (await lstat(directory)).isDirectory(),
      "Cell directories cannot be linked elsewhere.",
    );
  const start = await readComparisonJson(path.join(evidence, "session-start.json"));
  requireValue(
    BINDING.every((key) => typeof start[key] === "string" && receipt?.[key] === start[key]),
    "Workflow receipt does not belong to this supervised cell.",
  );
  requireValue(
    ["native_receipts", "controlled_fixture"].includes(receipt.source),
    "Identify the source of the native journey evidence.",
  );
  requireValue(
    typeof receipt.nativeReceipt?.path === "string" &&
      /^native-[A-Za-z0-9][A-Za-z0-9._-]{0,112}$/u.test(receipt.nativeReceipt.path),
    "Retain one bounded native receipt directly in the evidence directory.",
  );
  requireValue(
    sha256(await ordinaryBytes(path.join(evidence, receipt.nativeReceipt.path))) === receipt.nativeReceipt.sha256,
    "Native receipt bytes changed.",
  );
  if (receipt.permissionReview) {
    requireValue(
      receipt.permissionReview.path === PERMISSION_REVIEW_FILE &&
        sha256(await ordinaryBytes(path.join(evidence, PERMISSION_REVIEW_FILE))) === receipt.permissionReview.sha256,
      "Retain the exact native permission review before attaching it to the workflow.",
    );
  }
  const lockPath = path.join(evidence, "workflow-command.lock");
  const lock = await open(lockPath, "wx", 0o600);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, action }));
    await lock.sync();
    const task = COMPARISON_TASKS.find((entry) => entry.id === start.taskId);
    requireValue(task, "The cell task is unavailable.");
    if (start.taskId === "workflow_capture_reuse") {
      return await skillWorkflow({
        root,
        workspace,
        evidence,
        start,
        task,
        action,
        receipt,
        instructions,
        executionFile,
      });
    }
    requireValue(start.taskId === "scheduled_delivery", "This cell does not need a supervised workflow.");
    return await scheduleWorkflow({ root, evidence, start, task, action, receipt, executionFile });
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

async function skillWorkflow({ root, workspace, evidence, start, task, action, receipt, instructions, executionFile }) {
  requireValue(["source", "review", "reuse"].includes(action), "Skill workflow actions are source, review, and reuse.");
  const sourcePath = path.join(evidence, "workflow-source.json");
  if (action === "source") {
    requireValue(
      receipt.phase?.id === "source_workflow" && receipt.phase.status === "completed",
      "Complete the source workflow before capture.",
    );
    assertTurn(receipt.phase);
    const artifact = await ordinaryBytes(path.join(workspace, "source-release.md"));
    requireValue(
      receipt.phase.sourceArtifactSha256 === sha256(artifact),
      "Source artifact does not match the retained native turn.",
    );
    requireValue(
      artifact.toString("utf8").includes("Missing attachment name") &&
        artifact.toString("utf8").includes("attachment-name regression test passed"),
      "Retain the actual source workflow output before capture.",
    );
    await writeExact(sourcePath, receipt);
    await writeExact(path.join(root, "phase-capture-review.txt"), task.phases[1].prompt + "\n");
    return {
      next: "capture_review",
      promptFile: path.join(root, "phase-capture-review.txt"),
      operatorAction: task.phases[1].operatorAction,
    };
  }
  const source = await readComparisonJson(sourcePath);
  requireValue(receipt.source === source.source, "Do not combine controlled and native evidence.");
  requireValue(
    sha256(await ordinaryBytes(path.join(workspace, "source-release.md"))) === source.phase.sourceArtifactSha256,
    "The source output changed after capture began.",
  );
  if (action === "review") {
    const phase = receipt.phase;
    assertTurn(phase);
    requireValue(
      typeof instructions === "string" && Buffer.byteLength(instructions) <= 128 * 1024 && instructions.length > 0,
      "Retain the bounded exact reviewed skill instructions.",
    );
    const digest = sha256(instructions);
    requireValue(
      phase.id === "capture_review" &&
        phase.sessionId === source.phase.sessionId &&
        phase.turnId !== source.phase.turnId &&
        phase.sourceSessionId === source.phase.sessionId &&
        phase.sourceTurnId === source.phase.turnId &&
        phase.sourceArtifactSha256 === source.phase.sourceArtifactSha256,
      "Capture must refer to the completed source turn and artifact.",
    );
    requireValue(
      phase.reviewDecision === "approved" &&
        phase.instructionsSha256 === digest &&
        phase.reviewedInstructionsSha256 === digest &&
        identifier(phase.skillVersionId),
      "The product owner must approve the exact captured skill version before reuse.",
    );
    requireValue(
      Array.isArray(receipt.activationEvents) &&
        receipt.activationEvents.length <= 100 &&
        receipt.activationEvents.some(
          (event) => event.skillVersionId === phase.skillVersionId && event.instructionsSha256 === digest,
        ),
      "Retain the native exact-version activation event.",
    );
    await writeExact(path.join(evidence, "reviewed-skill.md"), instructions);
    await writeExact(path.join(evidence, "workflow-review.json"), receipt);
    // Intent is durable before the held-out fixture is exposed. Exact replay
    // repairs an interrupted release without overwriting agent or operator edits.
    for (const [name, content] of Object.entries(task.phases[2].files)) {
      await mkdir(path.dirname(path.join(workspace, name)), { recursive: true });
      await writeExact(path.join(workspace, name), content);
    }
    await writeExact(path.join(root, "phase-reuse.txt"), task.phases[2].prompt + "\n");
    return { next: "reuse", promptFile: path.join(root, "phase-reuse.txt"), newSession: true };
  }
  const review = await readComparisonJson(path.join(evidence, "workflow-review.json"));
  const phase = receipt.phase;
  assertTurn(phase);
  requireValue(
    phase.id === "reuse" &&
      phase.sessionId !== source.phase.sessionId &&
      phase.loadedInstructionsSha256 === review.phase.instructionsSha256 &&
      phase.skillVersionId === review.phase.skillVersionId,
    "Reuse must load the exact approved version in a new native session.",
  );
  requireValue(
    sha256(await ordinaryBytes(path.join(evidence, "reviewed-skill.md"))) === review.phase.instructionsSha256,
    "Reviewed instructions changed.",
  );
  await writeExact(path.join(evidence, "workflow-reuse.json"), receipt);
  await writeExact(path.join(evidence, executionFile), {
    ...execution(start, receipt.source),
    nativeReceipts: [
      ...[source, review, receipt].map((entry) => entry.nativeReceipt),
      ...(receipt.permissionReview ? [receipt.permissionReview] : []),
    ],
    workflow: { phases: [source.phase, review.phase, phase], activationEvents: review.activationEvents },
  });
  return { next: "independent_verification", taskOutcome: "unverified" };
}

async function scheduleWorkflow({ root, evidence, start, task, action, receipt, executionFile }) {
  requireValue(["schedule", "reconnect"].includes(action), "Delivery workflow actions are schedule and reconnect.");
  if (action === "schedule") {
    const delivery = receipt.delivery;
    requireValue(
      delivery &&
        identifier(delivery.scheduleId) &&
        delivery.schedulePersisted === true &&
        typeof delivery.authorizedDestination === "string" &&
        /^[A-Za-z0-9_@:.+-]{1,200}$/u.test(delivery.authorizedDestination) &&
        Number.isFinite(Date.parse(delivery.scheduledFor)),
      "Retain the native schedule and explicit authorized test destination.",
    );
    await writeExact(path.join(evidence, "workflow-schedule.json"), receipt);
    await writeExact(
      path.join(root, "phase-reconnect.txt"),
      `${task.prompt}\nRetain the provider receipt, reconnect, and observe for at least 30 seconds. Do not schedule a second reminder.\n`,
    );
    return { next: "reconnect", promptFile: path.join(root, "phase-reconnect.txt") };
  }
  const scheduled = await readComparisonJson(path.join(evidence, "workflow-schedule.json"));
  requireValue(receipt.source === scheduled.source, "Do not combine controlled and native evidence.");
  for (const key of ["scheduleId", "scheduledFor", "authorizedDestination", "schedulePersisted"])
    requireValue(
      receipt.delivery?.[key] === scheduled.delivery[key],
      "Reconnect evidence changed the native schedule or authorization.",
    );
  await writeExact(path.join(evidence, "workflow-reconnect.json"), receipt);
  await writeExact(path.join(evidence, executionFile), {
    ...execution(start, receipt.source),
    nativeReceipts: [
      scheduled.nativeReceipt,
      receipt.nativeReceipt,
      ...(receipt.permissionReview ? [receipt.permissionReview] : []),
    ],
    delivery: receipt.delivery,
  });
  return { next: "independent_verification", taskOutcome: "unverified" };
}

function execution(start, source) {
  return {
    schemaVersion: "goatcitadel.agent-comparison.execution.v1",
    ...Object.fromEntries(BINDING.map((key) => [key, start[key]])),
    product: start.product,
    taskId: start.taskId,
    source,
  };
}
function identifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/u.test(value);
}
function assertTurn(phase) {
  requireValue(
    phase && identifier(phase.sessionId) && identifier(phase.turnId),
    "Retain canonical native session and turn identifiers.",
  );
}
async function ordinaryBytes(filename) {
  const metadata = await lstat(filename);
  requireValue(
    metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      metadata.size <= 4 * 1024 * 1024 &&
      path.resolve(filename) === (await realpath(filename)),
    "Evidence must be a bounded ordinary file without linked parents.",
  );
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await handle.stat();
    requireValue(
      actual.isFile() && actual.size === metadata.size && actual.size <= 4 * 1024 * 1024,
      "Evidence changed before reading.",
    );
    const bytes = Buffer.alloc(actual.size);
    let offset = 0;
    while (offset < bytes.length) {
      const part = await handle.read(bytes, offset, bytes.length - offset, offset);
      requireValue(part.bytesRead > 0, "Evidence was truncated.");
      offset += part.bytesRead;
    }
    const after = await handle.stat();
    requireValue(after.size === actual.size && after.mtimeMs === actual.mtimeMs, "Evidence changed while reading.");
    return bytes;
  } finally {
    await handle.close();
  }
}
async function writeExact(filename, value) {
  const parent = path.dirname(filename);
  requireValue(
    (await realpath(parent)) === path.resolve(parent) && (await lstat(parent)).isDirectory(),
    "Workflow output parent cannot be a link.",
  );
  const bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
  let file;
  try {
    file = await open(filename, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    requireValue(
      (await ordinaryBytes(filename)).equals(bytes),
      "Workflow replay conflicts with retained evidence or task output.",
    );
    return;
  }
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}

export { VERSION as COMPARISON_WORKFLOW_VERSION };

export async function readComparisonWorkflowInstructions(filename) {
  const bytes = await ordinaryBytes(filename);
  requireValue(bytes.length <= 128 * 1024, "Reviewed skill exceeds the bound.");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
