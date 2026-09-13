import fs from "node:fs/promises";
import { constants, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { COMPARISON_TASKS, PRODUCTS, sha256 } from "./agent-comparison.mjs";
import {
  EXECUTION_BINDING_FIELDS,
  normalizeComparisonPermissions,
  PERMISSION_REVIEW_FILE,
  PERMISSION_REVIEW_VERSION,
} from "./agent-comparison-permissions.mjs";

export const COMPARISON_VERIFIER_ID = "goatcitadel.comparison-verifier.v1";
export const COMPARISON_VERIFIER_SHA256 = sha256({
  verifier: sha256(readFileSync(new URL(import.meta.url))),
  fixtures: sha256(readFileSync(new URL("./agent-comparison.mjs", import.meta.url))),
  permissions: sha256(readFileSync(new URL("./agent-comparison-permissions.mjs", import.meta.url))),
});
const EVIDENCE_VERSION = "goatcitadel.agent-comparison.execution.v1";
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** Evidence is retained by a product adapter/operator, outside the agent's output
 * directory. These checks do not accept model self-grades or authenticate a
 * third-party log by its filename; retain the native source receipts as well. */
export async function verifyComparisonEvidence({ taskId, workspaceRoot, evidenceRoot }) {
  const task = COMPARISON_TASKS.find((item) => item.id === taskId);
  requireValue(task, "Unknown comparison task.");
  const workspace = await ordinaryRoot(workspaceRoot);
  const evidence = await ordinaryRoot(evidenceRoot);
  requireValue(
    !within(workspace, evidence) && !within(evidence, workspace),
    "Verifier evidence and agent workspace must be disjoint.",
  );
  const reads = new Map();
  const verificationRuns = {};
  const read = async (root, name) => {
    const bytes = await readOwnedFile(root, name);
    reads.set(`${root === workspace ? "workspace" : "evidence"}/${name}`, sha256(bytes));
    return bytes.toString("utf8");
  };
  const execution = JSON.parse(await read(evidence, "execution.json"));
  requireValue(
    execution.schemaVersion === EVIDENCE_VERSION &&
      execution.taskId === taskId &&
      PRODUCTS.includes(execution.product) &&
      ["native_receipts", "controlled_fixture"].includes(execution.source),
    "Retain adapter-owned native execution evidence with its source kind.",
  );
  requireValue(
    Array.isArray(execution.nativeReceipts) &&
      execution.nativeReceipts.length > 0 &&
      execution.nativeReceipts.length <= 100,
    "At least one retained native receipt is required.",
  );
  const receiptPaths = new Set();
  let permissionReview = null;
  for (const receipt of execution.nativeReceipts) {
    requireValue(
      receipt && receipt.path !== "execution.json" && !receiptPaths.has(receipt.path),
      "Native receipt references must be distinct from the execution summary.",
    );
    receiptPaths.add(receipt.path);
    const bytes = await readOwnedFile(evidence, receipt.path);
    requireValue(sha256(bytes) === receipt.sha256, "Native receipt bytes changed.");
    reads.set(`evidence/${receipt.path}`, receipt.sha256);
    if (receipt.path === PERMISSION_REVIEW_FILE) permissionReview = JSON.parse(bytes.toString("utf8"));
  }
  let permissionEvidence = null;
  if (permissionReview) {
    requireValue(
      permissionReview.schemaVersion === PERMISSION_REVIEW_VERSION &&
        EXECUTION_BINDING_FIELDS.every(
          (key) => typeof execution[key] === "string" && permissionReview[key] === execution[key],
        ) &&
        typeof permissionReview.reviewedBy === "string" &&
        permissionReview.reviewedBy.trim() &&
        permissionReview.reviewedBy.length <= 200 &&
        typeof permissionReview.reviewedAt === "string" &&
        Number.isFinite(Date.parse(permissionReview.reviewedAt)) &&
        Array.isArray(permissionReview.sourceReceipts) &&
        permissionReview.sourceReceipts.length > 0 &&
        permissionReview.sourceReceipts.length <= 100 &&
        permissionReview.sourceReceipts.every(
          (receipt) =>
            receipt.path !== PERMISSION_REVIEW_FILE &&
            /^[a-f0-9]{64}$/u.test(receipt.sha256 ?? "") &&
            reads.get(`evidence/${receipt.path}`) === receipt.sha256,
        ),
      "Permission review must bind this exact execution and retained native configuration receipts.",
    );
    permissionEvidence = {
      schemaVersion: PERMISSION_REVIEW_VERSION,
      policy: normalizeComparisonPermissions(permissionReview.policy),
      evidenceSha256: reads.get(`evidence/${PERMISSION_REVIEW_FILE}`),
    };
  }
  let fixturesPreserved = true;
  for (const [name, value] of Object.entries(task.files)) {
    if (taskId === "code_repair" && name === "src/total.mjs") continue;
    fixturesPreserved &&= (await read(workspace, name)) === value;
  }
  const passed = Object.fromEntries(task.criteria.map((criterion) => [criterion, false]));
  if (taskId === "cited_research") {
    const answer = JSON.parse(await read(workspace, "answer.json"));
    const plans = Array.isArray(answer.plans) ? answer.plans : [];
    const find = (name, gb) => plans.find((plan) => plan.name === name && plan.includedGb === gb);
    passed.correct_prices =
      plans.length === 3 &&
      find("Atlas", 100)?.monthlyPriceUsd === 12 &&
      find("Beacon", 50)?.monthlyPriceUsd === 9 &&
      find("Beacon", 100)?.monthlyPriceUsd === 15;
    passed.correct_storage =
      plans.length === 3 && Boolean(find("Atlas", 100) && find("Beacon", 50) && find("Beacon", 100));
    passed.atlas_recommended_for_80gb =
      answer.recommendation?.name === "Atlas" && answer.recommendation.requiredGb === 80;
    passed.claims_cited =
      plans.length === 3 &&
      plans.every((plan) => plan.source === (plan.name === "Atlas" ? "sources/atlas.md" : "sources/beacon.md")) &&
      answer.recommendation?.source === "sources/atlas.md";
  } else if (taskId === "code_repair") {
    const files = await listFiles(workspace);
    const tests = files.filter((name) => /(?:^|\/)[^/]+\.(?:test|spec)\.mjs$/u.test(name));
    const implementation = await readOwnedFile(workspace, "src/total.mjs");
    reads.set("workspace/src/total.mjs", sha256(implementation));
    for (const name of tests) await read(workspace, name);
    const independent = await probeTotals(workspace);
    const focused =
      tests.length > 0
        ? await runNode(workspace, ["--test", ...tests])
        : { exitCode: null, output: "No focused tests" };
    verificationRuns.independentCodeChecks = independent;
    verificationRuns.focusedCodeTests = focused;
    reads.set("verifier/independent-code-checks", sha256(independent));
    reads.set("verifier/focused-code-tests", sha256(focused));
    passed.correct_totals = independent.checks?.correctTotals === true;
    passed.invalid_input_rejected = independent.checks?.invalidInputRejected === true;
    passed.focused_tests_pass = focused.exitCode === 0;
    passed.unrelated_files_preserved =
      fixturesPreserved &&
      files.every((name) => name === "src/total.mjs" || tests.includes(name) || Object.hasOwn(task.files, name));
  } else if (taskId === "document_generation") {
    const report = await read(workspace, "report.md");
    passed.facts_preserved = ["Harbor", "2030-03-14", "25", "Ari", "2030-03-10", "2030-03-12"].every((fact) =>
      new RegExp(`\\b${fact}\\b`, "u").test(report),
    );
    passed.actionable_checklist =
      /^-\s*\[[ x]\].*(?:Ari|backup)/imu.test(report) &&
      /checklist/iu.test(report) &&
      /risk/iu.test(report) &&
      /recommend/iu.test(report);
    passed.missing_owner_identified =
      /(?:missing|unassigned|unknown|not assigned).{0,60}(?:rollback|owner)|(?:rollback|owner).{0,60}(?:missing|unassigned|unknown|not assigned)/isu.test(
        report,
      );
    passed.artifact_created = report.length > 60 && /executive summary/iu.test(report);
  } else if (taskId === "workflow_capture_reuse") {
    const sourceText = await read(workspace, "source-release.md");
    const output = await read(workspace, "release.md");
    const instructions = await read(evidence, "reviewed-skill.md");
    const skillHash = sha256(instructions);
    const trace = execution.workflow;
    requireValue(trace && typeof trace === "object", "Workflow capture requires native phase and skill-load evidence.");
    const phases = Array.isArray(trace.phases) ? trace.phases : [];
    const [source, capture, reuse] = phases;
    const ordered =
      phases.length === 3 &&
      [source?.id, capture?.id, reuse?.id].join(",") === "source_workflow,capture_review,reuse" &&
      [source, capture, reuse].every(
        (phase) =>
          typeof phase.sessionId === "string" && phase.sessionId && typeof phase.turnId === "string" && phase.turnId,
      );
    passed.source_workflow_verified =
      ordered &&
      source.status === "completed" &&
      releaseSections(
        sourceText,
        "Missing attachment name",
        "attachment-name regression test passed",
        "every attachment format works",
      );
    passed.skill_captured_from_source =
      ordered &&
      capture.sourceTurnId === source.turnId &&
      capture.sessionId === source.sessionId &&
      capture.turnId !== source.turnId &&
      capture.sourceSessionId === source.sessionId &&
      capture.sourceArtifactSha256 === sha256(sourceText) &&
      capture.instructionsSha256 === skillHash &&
      capture.reviewedInstructionsSha256 === skillHash &&
      capture.reviewDecision === "approved" &&
      ["inputs", "instructions", "failure", "verification"].every((word) => instructions.toLowerCase().includes(word));
    passed.reviewed_skill_loaded_in_new_session =
      ordered &&
      reuse.sessionId !== source.sessionId &&
      reuse.sessionId !== capture.sessionId &&
      reuse.loadedInstructionsSha256 === skillHash &&
      reuse.skillVersionId === capture.skillVersionId &&
      Boolean(capture.skillVersionId);
    passed.output_contract_followed = releaseSections(
      output,
      "Duplicate reminder after reconnect",
      "reconnect regression test passed",
      "all providers are faster",
    );
    passed.unverified_claim_separated =
      section(output, "unverified").includes("all providers are faster") &&
      !section(output, "what changed").includes("all providers are faster");
    passed.no_unrequested_activation =
      Array.isArray(trace.activationEvents) &&
      trace.activationEvents.length === 1 &&
      trace.activationEvents[0].skillVersionId === capture?.skillVersionId &&
      trace.activationEvents[0].instructionsSha256 === skillHash;
    const reuseFixture = task.phases[2].files["input/changes.json"];
    fixturesPreserved &&= (await read(workspace, "input/changes.json")) === reuseFixture;
  } else {
    const delivery = execution.delivery;
    requireValue(
      delivery && typeof delivery === "object",
      "Scheduled delivery requires native schedule and provider receipts.",
    );
    const receipts = Array.isArray(delivery.receipts) ? delivery.receipts : [];
    passed.schedule_persisted =
      typeof delivery.scheduleId === "string" &&
      Boolean(delivery.scheduleId) &&
      Number.isFinite(Date.parse(delivery.scheduledFor)) &&
      delivery.schedulePersisted === true;
    passed.authorized_destination =
      typeof delivery.authorizedDestination === "string" &&
      Boolean(delivery.authorizedDestination) &&
      receipts.length > 0 &&
      receipts.every((receipt) => receipt.destination === delivery.authorizedDestination);
    passed.provider_receipt =
      receipts.length === 1 &&
      receipts[0].message === "HARBOR PILOT CHECK" &&
      typeof receipts[0].providerMessageId === "string" &&
      Boolean(receipts[0].providerMessageId) &&
      Number.isFinite(Date.parse(receipts[0].acknowledgedAt));
    passed.no_duplicate_after_reconnect =
      passed.provider_receipt &&
      Date.parse(delivery.reconnectedAt) >= Date.parse(receipts[0].acknowledgedAt) &&
      Date.parse(delivery.observedUntil) >= Date.parse(delivery.reconnectedAt) + 30_000 &&
      delivery.pendingDeliveries === 0;
  }
  const evidenceSha256 = sha256([...reads.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  return {
    verifier: COMPARISON_VERIFIER_ID,
    verifierSha256: COMPARISON_VERIFIER_SHA256,
    executionBinding: Object.fromEntries(
      ["executionId", "manifestSha256", "cellId", "revision", "effectiveConfigSha256", "fixtureSha256"]
        .filter((key) => typeof execution[key] === "string")
        .map((key) => [key, execution[key]]),
    ),
    taskId,
    product: execution.product,
    evidenceKind: execution.source === "controlled_fixture" ? "controlled" : "live",
    permissionEvidence,
    outcome: fixturesPreserved && Object.values(passed).every(Boolean) ? "passed" : "failed",
    fixturesPreserved,
    evidence: Object.fromEntries(reads),
    verificationRuns,
    checks: Object.fromEntries(
      task.criteria.map((criterion) => [
        criterion,
        { passed: Boolean(passed[criterion] && fixturesPreserved), evidenceSha256 },
      ]),
    ),
  };
}

function section(text, name) {
  const parts = text.split(/^#{1,6}\s+/mu);
  const found = parts.find((part) => part.split(/\r?\n/u, 1)[0].trim().toLowerCase() === name);
  return found?.slice(found.indexOf("\n") + 1) ?? "";
}
function releaseSections(text, change, evidence, unverified) {
  return (
    section(text, "what changed").includes(change) &&
    section(text, "evidence").includes(evidence) &&
    section(text, "unverified").includes(unverified) &&
    !section(text, "what changed").includes(unverified)
  );
}
function within(root, filename) {
  const relative = path.relative(root, filename);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
async function ordinaryRoot(value) {
  requireValue(typeof value === "string" && path.isAbsolute(value), "Evidence roots must be absolute.");
  const root = await fs.realpath(value);
  requireValue(path.resolve(root) === path.resolve(value), "Evidence roots must not be links.");
  requireValue((await fs.lstat(root)).isDirectory(), "Evidence root is not a directory.");
  return root;
}
async function readOwnedFile(root, relative) {
  requireValue(
    typeof relative === "string" &&
      relative.length > 0 &&
      !relative.includes("\\") &&
      !relative.includes(":") &&
      !path.isAbsolute(relative) &&
      !relative.split("/").some((part) => ["", ".", ".."].includes(part)),
    "Evidence file must have a bounded relative path.",
  );
  const filename = path.resolve(root, relative);
  requireValue(within(root, filename), "Evidence file left its owner root.");
  const resolved = await fs.realpath(filename);
  requireValue(resolved === filename, "Linked evidence files are not accepted.");
  const stat = await fs.lstat(filename);
  requireValue(
    stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= MAX_FILE_BYTES,
    "Evidence file is not an ordinary bounded file.",
  );
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const held = await handle.stat();
    requireValue(
      held.ino === stat.ino && held.dev === stat.dev && held.size === stat.size,
      "Evidence changed before read.",
    );
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    requireValue(length <= MAX_FILE_BYTES && length === held.size, "Evidence grew beyond its read bound.");
    const after = await handle.stat();
    requireValue(
      after.size === held.size && after.mtimeMs === held.mtimeMs && after.ctimeMs === held.ctimeMs,
      "Evidence changed during read.",
    );
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}
async function listFiles(root, relative = "", files = []) {
  requireValue(relative.split("/").length < 10 && files.length < 200, "Code fixture exceeded its bounds.");
  for (const item of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${item.name}` : item.name;
    requireValue(!item.isSymbolicLink(), "Linked code fixtures are not accepted.");
    if (item.isDirectory()) await listFiles(root, name, files);
    else if (item.isFile()) {
      requireValue(files.length < 200, "Code fixture exceeded its bounds.");
      files.push(name);
    } else throw new Error("Unsupported code fixture entry.");
  }
  return files;
}
async function probeTotals(workspace) {
  const moduleUrl = pathToFileURL(path.join(workspace, "src/total.mjs")).href;
  const script = `import {totalCents} from ${JSON.stringify(moduleUrl)};
import assert from 'node:assert/strict';
let correctTotals=false,invalidInputRejected=false;
try { assert.equal(totalCents([]),0); for(let i=1;i<=40;i++) { const items=[{unitCents:i*13,quantity:i%5},{unitCents:57,quantity:3}]; assert.equal(totalCents(items),i*13*(i%5)+171); } correctTotals=true; } catch {}
try { for(const value of [-1,0.1,NaN,Infinity,'3',null]) { assert.throws(()=>totalCents([{unitCents:value,quantity:2}])); assert.throws(()=>totalCents([{unitCents:3,quantity:value}])); } invalidInputRejected=true; } catch {}
process.stdout.write(JSON.stringify({correctTotals,invalidInputRejected}));`;
  const result = await runNode(workspace, ["--input-type=module", "-e", script]);
  let checks;
  try {
    checks = result.exitCode === 0 ? JSON.parse(result.output) : undefined;
  } catch {
    /* Malformed output cannot pass. */
  }
  return { ...result, checks };
}
async function runNode(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--max-old-space-size=128", ...args], {
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: path.dirname(process.execPath), SystemRoot: process.env.SystemRoot },
    });
    let output = "";
    let bounded = true;
    const stop = () => {
      if (!bounded) return;
      bounded = false;
      if (process.platform === "win32" && child.pid) {
        const killer = spawn(
          path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
          ["/pid", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
        killer.on("error", () => child.kill());
      } else if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const timer = setTimeout(stop, 15_000);
    const collect = (bytes) => {
      if (!bounded) return;
      output += bytes.toString();
      if (Buffer.byteLength(output) > 64 * 1024) {
        output = Buffer.from(output)
          .subarray(0, 64 * 1024)
          .toString();
        stop();
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ exitCode: null, output: "Verifier subprocess unavailable" });
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode: bounded ? exitCode : null, output });
    });
  });
}
