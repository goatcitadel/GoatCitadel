export type PatchLifecycleState = "apply" | "export" | "revert";

export type PatchLifecycleStatus = "not_requested" | "pending" | "succeeded" | "failed" | "unknown";

export type PatchDiagnosticCode =
  | "dirty_worktree_without_artifact"
  | "missing_claimed_file"
  | "missing_claimed_test"
  | "missing_claimed_artifact"
  | "empty_workbench_diff";

export type PatchChangedFileKind = "added" | "modified" | "deleted" | "renamed" | "unknown";

export interface PatchDiagnostic {
  code: PatchDiagnosticCode;
  severity: "info" | "warning" | "error";
  message: string;
  subject?: string;
}

export interface PatchChangedFileEvidence {
  path: string;
  previousPath?: string;
  kind: PatchChangedFileKind;
  source: "workbench_diff";
  hunks?: number;
}

export interface PatchLifecycleRecord {
  state: PatchLifecycleState;
  status: PatchLifecycleStatus;
  at?: string;
  evidence?: string;
}

export interface ClaimedTest {
  id?: string;
  command?: string;
  path?: string;
}

export interface ClaimedArtifact {
  id?: string;
  path?: string;
}

export interface TestEvidence {
  id?: string;
  command?: string;
  path?: string;
  status?: "passed" | "failed" | "skipped" | "unknown";
}

export interface ArtifactEvidence {
  id?: string;
  path?: string;
  kind?: string;
}

export interface WorktreeEvidence {
  dirty?: boolean;
  files?: string[];
  tests?: TestEvidence[];
  artifacts?: ArtifactEvidence[];
}

export interface PatchReviewClaims {
  files?: string[];
  tests?: ClaimedTest[];
  artifacts?: ClaimedArtifact[];
}

export interface PatchLifecycleInput {
  apply?: PatchLifecycleStatus | PatchLifecycleRecord;
  export?: PatchLifecycleStatus | PatchLifecycleRecord;
  revert?: PatchLifecycleStatus | PatchLifecycleRecord;
}

export interface WorkbenchDiffFile {
  path: string;
  previousPath?: string;
  kind?: PatchChangedFileKind;
  patch?: string;
  hunks?: number;
}

export interface WorkbenchDiffRecord {
  id?: string;
  files?: WorkbenchDiffFile[];
  diff?: string;
  patch?: string;
}

export interface DerivePatchArtifactRecordInput {
  id?: string;
  workbenchDiff: string | WorkbenchDiffRecord;
  claims?: PatchReviewClaims;
  evidence?: WorktreeEvidence;
  lifecycle?: PatchLifecycleInput;
  createdAt?: string;
}

export interface PatchClaimVerification {
  files: {
    claimed: string[];
    present: string[];
    missing: string[];
  };
  tests: {
    claimed: ClaimedTest[];
    present: ClaimedTest[];
    missing: ClaimedTest[];
  };
  artifacts: {
    claimed: ClaimedArtifact[];
    present: ClaimedArtifact[];
    missing: ClaimedArtifact[];
  };
}

export interface PatchArtifactRecord {
  id?: string;
  createdAt: string;
  changedFiles: PatchChangedFileEvidence[];
  lifecycle: PatchLifecycleRecord[];
  claims: PatchClaimVerification;
  diagnostics: PatchDiagnostic[];
}

interface MutableParsedFile {
  path?: string;
  previousPath?: string;
  kind: PatchChangedFileKind;
  hunks: number;
}

const lifecycleStates: PatchLifecycleState[] = ["apply", "export", "revert"];

export function derivePatchArtifactRecord(input: DerivePatchArtifactRecordInput): PatchArtifactRecord {
  const changedFiles = deriveChangedFileEvidence(input.workbenchDiff);
  const claims = verifyPatchClaims(input.claims, input.evidence);
  const lifecycle = buildPatchLifecycleRecords(input.lifecycle);
  const diagnostics = buildDiagnostics({
    changedFiles,
    claims,
    evidence: input.evidence,
  });

  const record: PatchArtifactRecord = {
    createdAt: input.createdAt ?? new Date().toISOString(),
    changedFiles,
    lifecycle,
    claims,
    diagnostics,
  };

  if (input.id) {
    record.id = input.id;
  }

  return record;
}

export function deriveChangedFileEvidence(workbenchDiff: string | WorkbenchDiffRecord): PatchChangedFileEvidence[] {
  if (typeof workbenchDiff !== "string") {
    const fromFiles =
      workbenchDiff.files?.map((file) =>
        buildChangedFileEvidence({
          path: normalizePath(file.path),
          previousPath: file.previousPath ? normalizePath(file.previousPath) : undefined,
          kind: file.kind ?? inferFileKind(file.previousPath, file.path),
          hunks: file.hunks ?? countHunks(file.patch ?? ""),
        }),
      ) ?? [];

    if (fromFiles.length > 0) {
      return dedupeChangedFiles(fromFiles);
    }

    return parseUnifiedDiff(workbenchDiff.diff ?? workbenchDiff.patch ?? "");
  }

  return parseUnifiedDiff(workbenchDiff);
}

export function verifyPatchClaims(
  claims: PatchReviewClaims = {},
  evidence: WorktreeEvidence = {},
): PatchClaimVerification {
  const evidenceFiles = new Set((evidence.files ?? []).map(normalizePath));
  const evidenceTests = evidence.tests ?? [];
  const evidenceArtifacts = evidence.artifacts ?? [];
  const claimedFiles = (claims.files ?? []).map(normalizePath);
  const claimedTests = claims.tests ?? [];
  const claimedArtifacts = claims.artifacts ?? [];

  return {
    files: {
      claimed: claimedFiles,
      present: claimedFiles.filter((file) => evidenceFiles.has(file)),
      missing: claimedFiles.filter((file) => !evidenceFiles.has(file)),
    },
    tests: {
      claimed: claimedTests,
      present: claimedTests.filter((claim) => hasMatchingTestEvidence(claim, evidenceTests)),
      missing: claimedTests.filter((claim) => !hasMatchingTestEvidence(claim, evidenceTests)),
    },
    artifacts: {
      claimed: claimedArtifacts,
      present: claimedArtifacts.filter((claim) => hasMatchingArtifactEvidence(claim, evidenceArtifacts)),
      missing: claimedArtifacts.filter((claim) => !hasMatchingArtifactEvidence(claim, evidenceArtifacts)),
    },
  };
}

export function buildPatchLifecycleRecords(lifecycle: PatchLifecycleInput = {}): PatchLifecycleRecord[] {
  return lifecycleStates.map((state) => {
    const value = lifecycle[state];

    if (!value) {
      return { state, status: "unknown" };
    }

    if (typeof value === "string") {
      return { state, status: value };
    }

    const record: PatchLifecycleRecord = {
      state,
      status: value.status,
    };

    if (value.at) {
      record.at = value.at;
    }

    if (value.evidence) {
      record.evidence = value.evidence;
    }

    return record;
  });
}

function buildDiagnostics(input: {
  changedFiles: PatchChangedFileEvidence[];
  claims: PatchClaimVerification;
  evidence?: WorktreeEvidence;
}): PatchDiagnostic[] {
  const diagnostics: PatchDiagnostic[] = [];

  if (input.changedFiles.length === 0) {
    diagnostics.push({
      code: "empty_workbench_diff",
      severity: "warning",
      message: "No changed files were derived from the workbench diff.",
    });
  }

  if (input.evidence?.dirty && (input.evidence.artifacts?.length ?? 0) === 0) {
    diagnostics.push({
      code: "dirty_worktree_without_artifact",
      severity: "warning",
      message: "The worktree is dirty, but no patch artifact evidence was provided.",
    });
  }

  for (const file of input.claims.files.missing) {
    diagnostics.push({
      code: "missing_claimed_file",
      severity: "error",
      subject: file,
      message: `Claimed file is missing from worktree evidence: ${file}`,
    });
  }

  for (const test of input.claims.tests.missing) {
    const subject = describeTestClaim(test);
    diagnostics.push({
      code: "missing_claimed_test",
      severity: "error",
      subject,
      message: `Claimed test is missing from test evidence: ${subject}`,
    });
  }

  for (const artifact of input.claims.artifacts.missing) {
    const subject = describeArtifactClaim(artifact);
    diagnostics.push({
      code: "missing_claimed_artifact",
      severity: "error",
      subject,
      message: `Claimed artifact is missing from artifact evidence: ${subject}`,
    });
  }

  return diagnostics;
}

function parseUnifiedDiff(diff: string): PatchChangedFileEvidence[] {
  const files: PatchChangedFileEvidence[] = [];
  let current: MutableParsedFile | undefined;

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      if (current) {
        pushParsedFile(files, current);
      }

      current = parseDiffGitLine(line);
      continue;
    }

    if (!current && (line.startsWith("--- ") || line.startsWith("+++ "))) {
      current = { kind: "unknown", hunks: 0 };
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("new file mode ")) {
      current.kind = "added";
      continue;
    }

    if (line.startsWith("deleted file mode ")) {
      current.kind = "deleted";
      continue;
    }

    if (line.startsWith("rename from ")) {
      current.previousPath = normalizePath(line.slice("rename from ".length));
      current.kind = "renamed";
      continue;
    }

    if (line.startsWith("rename to ")) {
      current.path = normalizePath(line.slice("rename to ".length));
      current.kind = "renamed";
      continue;
    }

    if (line.startsWith("--- ")) {
      const previousPath = extractDiffPath(line.slice(4));
      if (previousPath !== "/dev/null") {
        current.previousPath = previousPath;
      }
      continue;
    }

    if (line.startsWith("+++ ")) {
      const nextPath = extractDiffPath(line.slice(4));
      if (nextPath !== "/dev/null") {
        current.path = nextPath;
      }
      continue;
    }

    if (line.startsWith("@@")) {
      current.hunks += 1;
    }
  }

  if (current) {
    pushParsedFile(files, current);
  }

  return dedupeChangedFiles(files);
}

function parseDiffGitLine(line: string): MutableParsedFile {
  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);

  if (!match) {
    return { kind: "unknown", hunks: 0 };
  }

  const previousRaw = match[1];
  const nextRaw = match[2];
  if (!previousRaw || !nextRaw) {
    return { kind: "unknown", hunks: 0 };
  }

  const previousPath = normalizePath(previousRaw);
  const path = normalizePath(nextRaw);
  const parsed: MutableParsedFile = {
    path,
    kind: inferFileKind(previousPath, path),
    hunks: 0,
  };

  if (previousPath !== path) {
    parsed.previousPath = previousPath;
  }

  return parsed;
}

function pushParsedFile(files: PatchChangedFileEvidence[], parsed: MutableParsedFile): void {
  if (!parsed.path && !parsed.previousPath) {
    return;
  }

  const path = parsed.path ?? parsed.previousPath;
  if (!path) {
    return;
  }

  files.push(
    buildChangedFileEvidence({
      path,
      previousPath: parsed.previousPath,
      kind: parsed.kind,
      hunks: parsed.hunks,
    }),
  );
}

function dedupeChangedFiles(files: PatchChangedFileEvidence[]): PatchChangedFileEvidence[] {
  const byPath = new Map<string, PatchChangedFileEvidence>();

  for (const file of files) {
    const existing = byPath.get(file.path);
    if (!existing) {
      byPath.set(file.path, file);
      continue;
    }

    const merged: PatchChangedFileEvidence = {
      ...existing,
      kind: existing.kind === "unknown" ? file.kind : existing.kind,
      hunks: (existing.hunks ?? 0) + (file.hunks ?? 0),
    };

    const previousPath = existing.previousPath ?? file.previousPath;
    if (previousPath) {
      merged.previousPath = previousPath;
    }

    byPath.set(file.path, merged);
  }

  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function buildChangedFileEvidence(input: {
  path: string;
  previousPath: string | undefined;
  kind: PatchChangedFileKind;
  hunks: number | undefined;
}): PatchChangedFileEvidence {
  const evidence: PatchChangedFileEvidence = {
    path: input.path,
    kind: input.kind,
    source: "workbench_diff",
  };

  if (input.previousPath && input.previousPath !== input.path) {
    evidence.previousPath = input.previousPath;
  }

  if (input.hunks !== undefined) {
    evidence.hunks = input.hunks;
  }

  return evidence;
}

function inferFileKind(previousPath: string | undefined, path: string | undefined): PatchChangedFileKind {
  if (!previousPath || previousPath === "/dev/null") {
    return "added";
  }

  if (!path || path === "/dev/null") {
    return "deleted";
  }

  if (normalizePath(previousPath) !== normalizePath(path)) {
    return "renamed";
  }

  return "modified";
}

function countHunks(patch: string): number {
  return patch.split(/\r?\n/).filter((line) => line.startsWith("@@")).length;
}

function extractDiffPath(path: string): string {
  const trimmed = path.trim().split(/\t/)[0] ?? "";

  if (trimmed === "/dev/null") {
    return trimmed;
  }

  return normalizePath(trimmed.replace(/^[ab]\//, ""));
}

function hasMatchingTestEvidence(claim: ClaimedTest, evidence: TestEvidence[]): boolean {
  return evidence.some((item) => {
    if (claim.id && item.id === claim.id) {
      return true;
    }

    if (claim.command && item.command === claim.command) {
      return true;
    }

    return Boolean(claim.path && item.path && normalizePath(item.path) === normalizePath(claim.path));
  });
}

function hasMatchingArtifactEvidence(claim: ClaimedArtifact, evidence: ArtifactEvidence[]): boolean {
  return evidence.some((item) => {
    if (claim.id && item.id === claim.id) {
      return true;
    }

    return Boolean(claim.path && item.path && normalizePath(item.path) === normalizePath(claim.path));
  });
}

function describeTestClaim(claim: ClaimedTest): string {
  return claim.id ?? claim.command ?? claim.path ?? "unnamed test claim";
}

function describeArtifactClaim(claim: ClaimedArtifact): string {
  return claim.id ?? claim.path ?? "unnamed artifact claim";
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}
