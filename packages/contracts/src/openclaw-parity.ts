export type OpenclawParityEpicId =
  | "GC-P0-01"
  | "GC-P0-02"
  | "GC-P0-03"
  | "GC-P0-05"
  | "GC-P0-06"
  | "GC-P0-07"
  | "GC-P1-04"
  | "GC-P1-08"
  | "GC-P1-09"
  | "GC-P1-10"
  | "GC-P2-11"
  | "GC-P2-12";

export type OpenclawParityEpicStatus = "complete" | "in_progress" | "pending";

export type OpenclawParityBlockerKind =
  | "repo_runtime"
  | "manual_operator"
  | "external_repo"
  | "publication";

export interface OpenclawParityBlockerRecord {
  kind: OpenclawParityBlockerKind;
  summary: string;
}

export interface OpenclawParityBlockerCounts {
  repo_runtime: number;
  manual_operator: number;
  external_repo: number;
  publication: number;
}

export interface OpenclawParityEpicDefinition {
  epicId: OpenclawParityEpicId;
  label: string;
  status: OpenclawParityEpicStatus;
}

export interface OpenclawParityProgramEpicRecord {
  epicId: OpenclawParityEpicId;
  label: string;
  status: OpenclawParityEpicStatus;
  summary: string;
  nextSlice: string;
  blockers: OpenclawParityBlockerRecord[];
}

export interface OpenclawParityProgramReport {
  generatedAt: string;
  completedEpicIds: OpenclawParityEpicId[];
  openEpicIds: OpenclawParityEpicId[];
  completionOrder: OpenclawParityEpicId[];
  nextEpicId?: OpenclawParityEpicId;
  nextSlice: string;
  unsafeClaims: string[];
  blockerCounts: OpenclawParityBlockerCounts;
  epics: OpenclawParityProgramEpicRecord[];
}

export const OPENCLAW_PARITY_EPICS: OpenclawParityEpicDefinition[] = [
  {
    epicId: "GC-P0-01",
    label: "Shared channel runtime semantics",
    status: "complete",
  },
  {
    epicId: "GC-P0-02",
    label: "Stabilize core beta channels",
    status: "in_progress",
  },
  {
    epicId: "GC-P0-03",
    label: "Ship Tier-1 planned channels",
    status: "pending",
  },
  {
    epicId: "GC-P0-05",
    label: "Channel action API completeness",
    status: "complete",
  },
  {
    epicId: "GC-P0-06",
    label: "Browser control parity",
    status: "in_progress",
  },
  {
    epicId: "GC-P0-07",
    label: "Canvas / A2UI parity",
    status: "in_progress",
  },
  {
    epicId: "GC-P1-04",
    label: "Ship Tier-2 planned channels",
    status: "pending",
  },
  {
    epicId: "GC-P1-08",
    label: "Companion apps / nodes / device surfaces",
    status: "in_progress",
  },
  {
    epicId: "GC-P1-09",
    label: "Packaging and remote deployment parity",
    status: "in_progress",
  },
  {
    epicId: "GC-P1-10",
    label: "Long-tail parity register",
    status: "in_progress",
  },
  {
    epicId: "GC-P2-11",
    label: "Extension / plugin SDK breadth",
    status: "in_progress",
  },
  {
    epicId: "GC-P2-12",
    label: "Voice Wake / Talk Mode parity",
    status: "in_progress",
  },
];

export const OPENCLAW_PARITY_EPIC_IDS: OpenclawParityEpicId[] = OPENCLAW_PARITY_EPICS.map(
  (epic) => epic.epicId,
);

export const OPENCLAW_PARITY_COMPLETED_EPIC_IDS: OpenclawParityEpicId[] = OPENCLAW_PARITY_EPICS
  .filter((epic) => epic.status === "complete")
  .map((epic) => epic.epicId);

export const OPENCLAW_PARITY_OPEN_EPIC_IDS: OpenclawParityEpicId[] = OPENCLAW_PARITY_EPICS
  .filter((epic) => epic.status !== "complete")
  .map((epic) => epic.epicId);

// This is the full-program closeout order for finishing parity end to end.
// It intentionally differs from the follow-on-only order, which applies only
// when working the follow-on lanes before planned-channel completion.
export const OPENCLAW_PARITY_COMPLETION_ORDER: OpenclawParityEpicId[] = [
  "GC-P1-10",
  "GC-P2-12",
  "GC-P0-06",
  "GC-P1-09",
  "GC-P1-08",
  "GC-P0-07",
  "GC-P0-02",
  "GC-P0-03",
  "GC-P1-04",
  "GC-P2-11",
];
