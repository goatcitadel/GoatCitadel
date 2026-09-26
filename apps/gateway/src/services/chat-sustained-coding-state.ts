import { createHash } from "node:crypto";
import path from "node:path";
import type { ChatToolRunRecord } from "@goatcitadel/contracts";

export const CODING_ACTIVE_LIMIT_MS = 90 * 60_000;
export const CODING_TOOL_LIMIT = 120;

export interface CodingTestReceipt {
  toolRunId: string;
  passed: boolean;
  command: string;
  summary?: string;
  evidenceLabel?: string;
}

/** Checkpoint data is bounded and contains references and hashes, never file contents. */
export interface CodingRunCheckpoint {
  version: 1;
  turnId: string;
  userMessageId: string;
  requestSha256: string;
  constraints: { webOff: boolean; noNetwork: boolean; noPackageInstall: boolean; scopeRoot?: string };
  acceptance: { requiredFiles: string[]; requiredCommands: string[]; testsRequired: boolean; independentVerificationRequired: boolean };
  activeUsedMs: number;
  activeSegmentStartedAt: string;
  windowIndex: number;
  windowStartedAt: string;
  windowStartActiveMs: number;
  windowToolCursor: number;
  toolRunCursor: number;
  toolCallsConsumed: number;
  noProgressWindows: number;
  progressKeys: string[];
  windowProgressKeys: string[];
  changedFileHashes: Record<string, string>;
  firstTest?: CodingTestReceipt;
  latestTest?: CodingTestReceipt;
  latestFailure?: string;
  repairCount: number;
  repairCountedForLatestFailure: boolean;
  nextAction: string;
}

export function buildCodingCheckpoint(input: {
  turnId: string;
  userMessageId: string;
  request: string;
  webOff: boolean;
  now?: Date;
}): CodingRunCheckpoint {
  const now = (input.now ?? new Date()).toISOString();
  const scopeRoot = input.request.match(/\bWORK ONLY INSIDE:\s*\r?\n\s*([^\r\n]+)/iu)?.[1]?.trim();
  const requiredFiles = [...new Set(input.request.match(/\b[\w.-]+\.(?:ps1|psm1|py|ts|tsx|js|jsx|mjs|cjs|rs|go|java|cs|sh|bat|cmd|log|json)\b/giu) ?? [])];
  const requiredCommands = [...new Set(
    [
      ...[...input.request.matchAll(/^\s*\d+\.\s*(?:.*?[\\/])?([\w.-]+\.(?:ps1|psm1|py|sh|bat|cmd))\s*$/gimu)]
        .map((match) => match[1]!),
      ...[...input.request.matchAll(/^\s*(?:powershell(?:\.exe)?|pwsh(?:\.exe)?|python(?:\.exe)?)\b[^\r\n]*?\b([\w.-]+\.(?:ps1|py))\s*$/gimu)]
        .map((match) => match[1]!),
    ],
  )];
  return {
    version: 1,
    turnId: input.turnId,
    userMessageId: input.userMessageId,
    requestSha256: sha(input.request),
    constraints: {
      webOff: input.webOff,
      noNetwork: /\bdo not access the internet\b/iu.test(input.request),
      noPackageInstall: /\bdo not install packages\b/iu.test(input.request),
      ...(scopeRoot ? { scopeRoot } : {}),
    },
    acceptance: {
      requiredFiles: requiredFiles.slice(0, 64),
      requiredCommands: requiredCommands.slice(0, 24),
      testsRequired: /\b(?:run|execute|pass|validate|verify)\b[^.\n]{0,80}\btests?\b|\btest suite\b|\btests?\.(?:ps1|py|ts|js)\b/iu.test(input.request),
      independentVerificationRequired: /\bindependent(?:ly)?\s+(?:verification|verify|recompute)\b/iu.test(input.request),
    },
    activeUsedMs: 0,
    activeSegmentStartedAt: now,
    windowIndex: 0,
    windowStartedAt: now,
    windowStartActiveMs: 0,
    windowToolCursor: 0,
    toolRunCursor: 0,
    toolCallsConsumed: 0,
    noProgressWindows: 0,
    progressKeys: [],
    windowProgressKeys: [],
    changedFileHashes: {},
    repairCount: 0,
    repairCountedForLatestFailure: false,
    nextAction: "Inspect the workspace and identify the smallest implementation step.",
  };
}

export function recoverCodingCheckpoint(raw: unknown, expected: Pick<CodingRunCheckpoint, "turnId" | "userMessageId" | "requestSha256">): CodingRunCheckpoint | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const state = raw as Partial<CodingRunCheckpoint>;
  if (state.version !== 1 || state.turnId !== expected.turnId || state.userMessageId !== expected.userMessageId ||
      state.requestSha256 !== expected.requestSha256 || !Number.isFinite(state.activeUsedMs) ||
      typeof state.windowIndex !== "number" || !Number.isSafeInteger(state.windowIndex) || state.windowIndex < 0 ||
      typeof state.toolRunCursor !== "number" || !Number.isSafeInteger(state.toolRunCursor) || state.toolRunCursor < 0 ||
      typeof state.toolCallsConsumed !== "number" || !Number.isSafeInteger(state.toolCallsConsumed) || state.toolCallsConsumed < 0 ||
      typeof state.windowToolCursor !== "number" || !Number.isSafeInteger(state.windowToolCursor) || state.windowToolCursor < 0 ||
      state.windowToolCursor > state.toolRunCursor ||
      typeof state.repairCountedForLatestFailure !== "boolean" ||
      !Number.isFinite(state.windowStartActiveMs) || !Number.isFinite(Date.parse(state.activeSegmentStartedAt ?? "")) ||
      !Array.isArray(state.progressKeys) || !Array.isArray(state.windowProgressKeys) ||
      !state.acceptance || !state.changedFileHashes) return undefined;
  return state as CodingRunCheckpoint;
}

export function chargeCodingActiveTime(state: CodingRunCheckpoint, now = new Date(), waiting = false): CodingRunCheckpoint {
  const started = Date.parse(state.activeSegmentStartedAt);
  const elapsed = Number.isFinite(started) && !waiting ? Math.max(0, now.getTime() - started) : 0;
  return { ...state, activeUsedMs: Math.min(CODING_ACTIVE_LIMIT_MS, state.activeUsedMs + elapsed), activeSegmentStartedAt: now.toISOString() };
}

/** Called after a settled receipt; persisted cursor prevents replay from charging the same call twice. */
export function applyCodingToolReceipts(state: CodingRunCheckpoint, runs: readonly ChatToolRunRecord[]): CodingRunCheckpoint {
  const changedFileHashes = { ...state.changedFileHashes };
  const progressKeys = new Set(state.progressKeys);
  let firstTest = state.firstTest;
  let latestTest = state.latestTest;
  let latestFailure = state.latestFailure;
  let repairCount = state.repairCount;
  let repairCountedForLatestFailure = state.repairCountedForLatestFailure;
  for (const run of runs.slice(state.toolRunCursor)) {
    if (run.status === "executed" && ["fs.write", "fs.patch", "fs.read", "file.read_range"].includes(run.toolName)) {
      const file = typeof run.result?.path === "string" ? run.result.path : String(run.args?.path ?? "");
      const hash = typeof run.result?.afterSha256 === "string" ? run.result.afterSha256
        : typeof run.result?.sha256 === "string" ? run.result.sha256
          : run.toolName === "fs.write" ? sha(String(run.args?.content ?? "")) : undefined;
      if (file && hash) {
        changedFileHashes[file] = hash;
        if (["fs.write", "fs.patch"].includes(run.toolName)) progressKeys.add(`file:${file}:${hash}`);
      }
    }
    if (isCodingEditRun(run) && latestTest && !latestTest.passed && !repairCountedForLatestFailure) {
      repairCount += 1;
      repairCountedForLatestFailure = true;
    }
    const test = codingTestReceipt(run);
    if (test) {
      firstTest ??= test;
      latestTest = test;
      repairCountedForLatestFailure = false;
      progressKeys.add(`test:${test.passed}:${sha(test.summary ?? test.command)}`);
      if (!test.passed) latestFailure = (test.summary ?? `${test.command} failed`).slice(0, 500);
    } else if (run.status === "failed" || run.status === "blocked") {
      const failure = (run.error ?? run.failureGuidance ?? `${run.toolName} ${run.status}`).slice(0, 500);
      latestFailure = failure;
      progressKeys.add(`diagnostic:${sha(failure)}`);
    }
  }
  return {
    ...state,
    changedFileHashes,
    progressKeys: [...progressKeys].slice(-256),
    firstTest,
    latestTest,
    latestFailure,
    repairCount,
    repairCountedForLatestFailure,
    toolRunCursor: runs.length,
  };
}

export function advanceCodingWindow(state: CodingRunCheckpoint, now = new Date()): CodingRunCheckpoint {
  const progressed = state.progressKeys.some((key) => !state.windowProgressKeys.includes(key));
  return {
    ...state,
    windowIndex: state.windowIndex + 1,
    windowStartedAt: now.toISOString(),
    windowStartActiveMs: state.activeUsedMs,
    windowToolCursor: state.toolRunCursor,
    windowProgressKeys: [...state.progressKeys],
    noProgressWindows: progressed ? 0 : state.noProgressWindows + 1,
    nextAction: progressed ? "Continue from the latest diagnostic, edit, or test receipt." : "Inspect the repeated failure and change approach.",
  };
}

export function evaluateCodingCompletion(state: CodingRunCheckpoint, runs: readonly ChatToolRunRecord[], answer: string): string[] {
  const unmet: string[] = [];
  if (!runs.some((run) => run.status === "executed" &&
      ["fs.list", "fs.stat", "fs.read", "file.read_range", "code.search", "code.search_files", "fs.write", "fs.patch", "shell.exec", "tests.run", "lint.run"].includes(run.toolName))) {
    unmet.push("No successful coding tool receipt supports completion");
  }
  const lastPotentialMutation = runs.reduce((index, run, current) =>
    run.status === "executed" && ["fs.write", "fs.patch", "fs.copy", "fs.move", "fs.delete", "shell.exec", "tests.run", "lint.run"].includes(run.toolName)
      ? current : index, -1);
  const observedFiles = new Set<string>();
  for (const run of runs.slice(lastPotentialMutation + 1)) {
    if (run.status !== "executed") continue;
    const path = typeof run.result?.path === "string" ? run.result.path : typeof run.args?.path === "string" ? run.args.path : "";
    if (!path) continue;
    if (!["fs.stat", "fs.read", "file.read_range"].includes(run.toolName)) continue;
    if (run.toolName === "fs.stat" && run.result?.isFile !== true) continue;
    const observedPath = normalizeEvidencePath(path);
    const scopeRoot = state.constraints.scopeRoot && normalizeEvidencePath(state.constraints.scopeRoot);
    if (!observedPath || (scopeRoot && observedPath !== scopeRoot && !observedPath.startsWith(`${scopeRoot}/`))) continue;
    observedFiles.add(observedPath.split("/").at(-1)!);
  }
  for (const file of state.acceptance.requiredFiles) {
    if (!observedFiles.has(file.toLowerCase())) unmet.push(`No fresh file existence receipt for ${file}`);
  }
  for (const command of state.acceptance.requiredCommands) {
    if (!runs.some((run) => run.toolName === "shell.exec" && run.status === "executed" &&
        run.result?.exitCode === 0 && invokedScriptFile(commandText(run)) === command.toLowerCase())) {
      unmet.push(`No successful run receipt for ${command}`);
    }
  }
  let lastEdit = -1;
  let lastPassedTest = -1;
  let lastTest = -1;
  runs.forEach((run, index) => {
    if (isCodingEditRun(run)) lastEdit = index;
    const test = codingTestReceipt(run);
    if (test) lastTest = index;
    if (test?.passed) lastPassedTest = index;
  });
  if (state.acceptance.testsRequired && (lastPassedTest < 0 || lastPassedTest <= lastEdit || lastTest !== lastPassedTest)) {
    unmet.push("No passing test receipt after the last source edit");
  }
  const independentVerifierReceipt = runs.slice(Math.max(0, lastPassedTest + 1)).some(isSeparateVerificationReceipt);
  if (state.acceptance.independentVerificationRequired && !independentVerifierReceipt) {
    unmet.push("No separate verification receipt after the passing tests");
  }
  if (/\bindependently verified\b/iu.test(answer)) {
    unmet.push("No trusted independent verifier receipt supports that claim; describe the separate verification command instead");
  }
  if (/\ball tests (?:passed|pass)\b/iu.test(answer) &&
      (lastPassedTest < 0 || lastTest !== lastPassedTest || lastPassedTest <= lastEdit)) {
    unmet.push("The answer claims passing tests without a final passing test receipt");
  }
  for (const claimedCount of answer.matchAll(/\b(\d+)\s*\/\s*(\d+)\s+tests?\s+passed\b/giu)) {
    const label = `${claimedCount[1]}/${claimedCount[2]} tests passed`;
    if (lastPassedTest < 0 || lastTest !== lastPassedTest || lastPassedTest <= lastEdit ||
        codingTestReceipt(runs[lastPassedTest]!)?.evidenceLabel !== label) {
      unmet.push(`No final test receipt supports ${label}`);
    }
  }
  if (/\b(?:no|zero)\s+files?\s+(?:outside|beyond)\b[^.\n]{0,100}\bmodified\b/iu.test(answer)) {
    unmet.push("No recorded filesystem-wide audit supports the out-of-scope modification claim");
  }
  return [...new Set(unmet)];
}

function isCodingEditRun(run: ChatToolRunRecord): boolean {
  if (run.status !== "executed") return false;
  if (["fs.write", "fs.patch", "fs.copy", "fs.move", "fs.delete"].includes(run.toolName)) return true;
  if (run.toolName !== "shell.exec") return false;
  const command = commandText(run).trim();
  if (isRecognizedTestCommand(command) || isSeparateVerificationReceipt(run)) return false;
  // Shell has no filesystem jail or complete effect receipt. Only simple inspection
  // commands are known read-only; everything else can invalidate a prior test.
  return !/^(?:Get-Content|Get-ChildItem|Test-Path|Select-String|rg|git\s+(?:status|diff|log|show)|ls|dir|cat)\b/iu.test(command);
}

export function codingTestReceipt(run: ChatToolRunRecord): CodingTestReceipt | undefined {
  const command = commandText(run);
  if (run.toolName !== "tests.run" && !(run.toolName === "shell.exec" && isRecognizedTestCommand(command))) return undefined;
  const exitCode = run.result?.exitCode;
  const passed = run.status === "executed" && (exitCode === 0 || (exitCode === undefined && run.toolName === "tests.run"));
  const output = [run.result?.stdout, run.result?.stderr, run.error].filter((part): part is string => typeof part === "string" && Boolean(part)).join("\n");
  const count = passed ? output.match(/\b(\d+)\s*\/\s*(\d+)\s+tests?\s+passed\b/iu) : undefined;
  const evidenceLabel = count ? `${count[1]}/${count[2]} tests passed`
    : passed && exitCode === 0 ? "passed (exit 0)" : undefined;
  return { toolRunId: run.toolRunId, passed, command,
    ...(output ? { summary: output.slice(-500) } : {}),
    ...(evidenceLabel ? { evidenceLabel } : {}),
  };
}

function normalizeEvidencePath(value: string): string | undefined {
  if (/^[a-z]:[\\/]/iu.test(value) || /^\\\\/u.test(value)) {
    return path.win32.resolve(value).replaceAll("\\", "/").replace(/\/$/u, "").toLowerCase();
  }
  if (path.posix.isAbsolute(value)) return path.posix.resolve(value).replace(/\/$/u, "");
  return undefined;
}

function invokedScriptFile(command: string): string | undefined {
  const text = command.trim();
  const powerShell = text.match(/^(?:&\s*)?(?:powershell|pwsh)(?:\.exe)?\b([^\r\n;&|]*?)\s-(?:File|f)\s+("[^"]+"|'[^']+'|[^\s;&|]+)/iu);
  if (powerShell && !/\s-(?:Command|c)\b/iu.test(powerShell[1]!)) return scriptBasename(powerShell[2]!);
  const python = text.match(/^(?:python|py)(?:\.exe)?\b(?:\s+-[a-z]+)*\s+("[^"]+\.py"|'[^']+\.py'|[^\s;&|]+\.py)(?=\s|$)/iu);
  if (python) return scriptBasename(python[1]!);
  const direct = text.match(/^(?:&\s*)?("[^"]+\.(?:ps1|py)"|'[^']+\.(?:ps1|py)'|[^\s;&|]+\.(?:ps1|py))(?=\s|$)/iu);
  return direct ? scriptBasename(direct[1]!) : undefined;
}

function scriptBasename(value: string): string {
  return value.replace(/^["']|["']$/gu, "").replaceAll("\\", "/").split("/").at(-1)!.toLowerCase();
}

function isRecognizedTestCommand(command: string): boolean {
  const file = invokedScriptFile(command);
  if (file && /(?:^|[-_.])tests?(?:[-_.]|$)/iu.test(file)) return true;
  return /^(?:(?:pnpm|npm|yarn)(?:\.cmd)?\s+(?:run\s+)?test(?::[\w-]+)?|(?:npx\s+)?(?:pytest|vitest|jest)(?:\.cmd)?)(?:\s|$)/iu.test(command.trim());
}

function isSeparateVerificationReceipt(run: ChatToolRunRecord): boolean {
  if (run.toolName !== "shell.exec" || run.status !== "executed" || run.result?.exitCode !== 0) return false;
  const command = commandText(run).trim();
  return /^(?:python|py|pwsh|powershell)(?:\.exe)?\b/iu.test(command) &&
    /\b(?:open|read_text|Get-Content|ReadAllText)\b/iu.test(command) &&
    /\b(?:assert|throw|raise)\b/iu.test(command) &&
    /\b(?:median|p95|recomput|verify|independent)\b/iu.test(command) &&
    !/\b(?:write_text|writeFile|Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item)\b|\.write\s*\(/iu.test(command);
}

function commandText(run: ChatToolRunRecord): string {
  return typeof run.args?.command === "string" ? run.args.command : typeof run.args?.script === "string" ? run.args.script : "";
}

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
