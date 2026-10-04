export type CheckRunStatus = "not-run" | "queued" | "running" | "pass" | "fail" | "blocked" | "skipped" | "cancelled";
export type StepStatus = "running" | "pass" | "fail";
export type RunEndReason = "completed" | "stopped" | "unreachable";

export interface StepRecord {
  readonly title: string;
  readonly status: StepStatus;
}

export interface CheckLogEntry {
  readonly at: string;
  readonly message: string;
  readonly data?: unknown;
}

export interface CheckRecord {
  readonly status: CheckRunStatus;
  readonly summary: string | undefined;
  readonly evidence: unknown;
  readonly durationMs: number | undefined;
  readonly steps: readonly StepRecord[];
  readonly log: readonly CheckLogEntry[];
}

export interface RunState {
  readonly running: boolean;
  readonly startedAt: string | undefined;
  readonly finishedAt: string | undefined;
  readonly endReason: RunEndReason | undefined;
  readonly banner: string | undefined;
  readonly records: Readonly<Record<string, CheckRecord>>;
}

export type RunEvent =
  | { readonly type: "run-started"; readonly checkIds: readonly string[]; readonly at: string }
  | { readonly type: "check-skipped"; readonly checkId: string; readonly reason: string }
  | { readonly type: "check-started"; readonly checkId: string; readonly at: string }
  | { readonly type: "step-started"; readonly checkId: string; readonly title: string }
  | {
      readonly type: "step-finished";
      readonly checkId: string;
      readonly title: string;
      readonly status: "pass" | "fail";
    }
  | { readonly type: "check-logged"; readonly checkId: string; readonly entry: CheckLogEntry }
  | {
      readonly type: "check-finished";
      readonly checkId: string;
      readonly status: "pass" | "fail" | "blocked" | "cancelled";
      readonly summary: string;
      readonly evidence?: unknown;
      readonly durationMs: number;
    }
  | { readonly type: "run-finished"; readonly at: string; readonly reason: RunEndReason; readonly banner?: string };

export type StatusCounts = Readonly<Record<CheckRunStatus, number>>;

export const EMPTY_CHECK_RECORD: CheckRecord = {
  status: "not-run",
  summary: undefined,
  evidence: undefined,
  durationMs: undefined,
  steps: [],
  log: [],
};

export const INITIAL_RUN_STATE: RunState = {
  running: false,
  startedAt: undefined,
  finishedAt: undefined,
  endReason: undefined,
  banner: undefined,
  records: {},
};

export function recordFor(state: RunState, checkId: string): CheckRecord {
  return state.records[checkId] ?? EMPTY_CHECK_RECORD;
}

export function runReducer(state: RunState, event: RunEvent): RunState {
  switch (event.type) {
    case "run-started":
      return startRun(state, event.checkIds, event.at);
    case "check-skipped":
      return updateRecord(state, event.checkId, () => ({
        ...EMPTY_CHECK_RECORD,
        status: "skipped",
        summary: event.reason,
      }));
    case "check-started":
      return updateRecord(state, event.checkId, () => ({ ...EMPTY_CHECK_RECORD, status: "running" }));
    case "step-started":
      return updateRecord(state, event.checkId, (record) => ({
        ...record,
        steps: [...record.steps, { title: event.title, status: "running" }],
      }));
    case "step-finished":
      return updateRecord(state, event.checkId, (record) => ({
        ...record,
        steps: finishStep(record.steps, event.title, event.status),
      }));
    case "check-logged":
      return updateRecord(state, event.checkId, (record) => ({ ...record, log: [...record.log, event.entry] }));
    case "check-finished":
      return updateRecord(state, event.checkId, (record) => ({
        ...record,
        status: event.status,
        summary: event.summary,
        evidence: event.evidence,
        durationMs: event.durationMs,
      }));
    case "run-finished":
      return finishRun(state, event.at, event.reason, event.banner);
  }
}

export function countStatuses(state: RunState, checkIds: readonly string[]): StatusCounts {
  const counts: Record<CheckRunStatus, number> = {
    "not-run": 0,
    queued: 0,
    running: 0,
    pass: 0,
    fail: 0,
    blocked: 0,
    skipped: 0,
    cancelled: 0,
  };
  for (const checkId of checkIds) {
    counts[recordFor(state, checkId).status] += 1;
  }
  return counts;
}

function updateRecord(state: RunState, checkId: string, update: (record: CheckRecord) => CheckRecord): RunState {
  return { ...state, records: { ...state.records, [checkId]: update(recordFor(state, checkId)) } };
}

function startRun(state: RunState, checkIds: readonly string[], at: string): RunState {
  const queued = Object.fromEntries(
    checkIds.map((checkId): [string, CheckRecord] => [checkId, { ...EMPTY_CHECK_RECORD, status: "queued" }]),
  );
  return {
    running: true,
    startedAt: at,
    finishedAt: undefined,
    endReason: undefined,
    banner: undefined,
    records: { ...state.records, ...queued },
  };
}

function finishRun(state: RunState, at: string, reason: RunEndReason, banner: string | undefined): RunState {
  const leftover: CheckRunStatus = reason === "stopped" ? "cancelled" : "not-run";
  const records = Object.fromEntries(
    Object.entries(state.records).map(([checkId, record]): [string, CheckRecord] => [
      checkId,
      record.status === "queued" || record.status === "running" ? { ...record, status: leftover } : record,
    ]),
  );
  return { ...state, running: false, finishedAt: at, endReason: reason, banner, records };
}

function finishStep(steps: readonly StepRecord[], title: string, status: "pass" | "fail"): StepRecord[] {
  let index = -1;
  for (let position = steps.length - 1; position >= 0; position -= 1) {
    const step = steps[position];
    if (step?.title === title && step.status === "running") {
      index = position;
      break;
    }
  }
  return steps.map((step, position) => (position === index ? { ...step, status } : step));
}
