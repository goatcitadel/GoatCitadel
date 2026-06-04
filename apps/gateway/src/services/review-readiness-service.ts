import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type {
  ReviewFindingImportResult,
  ReviewFindingInput,
  ReviewReadinessLane,
  ReviewReadinessSummary,
  TaskRecord,
} from "@goatcitadel/contracts";
import type { TaskLifecycleService } from "./task-lifecycle-service.js";

export interface ReviewReadinessServiceDependencies {
  rootDir: string;
  taskLifecycleService: Pick<
    TaskLifecycleService,
    "appendTaskActivity" | "appendTaskDeliverable" | "createTask" | "listTasks" | "updateTask"
  >;
}

const READINESS_LANES = [
  { lane: "skills-catalog", command: "pnpm verify:skills:catalog" },
  { lane: "catalog-parity", command: "pnpm verify:catalog:parity" },
  { lane: "runtime-truth", command: "pnpm verify:runtime:truth" },
  { lane: "memory-truth", command: "pnpm verify:memory:truth" },
] as const;

const CURRENT_PROOF_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REVIEW_FINDING_PREFIX = "Review finding key:";

export class ReviewReadinessService {
  public constructor(private readonly deps: ReviewReadinessServiceDependencies) {}

  public getReadiness(): ReviewReadinessSummary {
    const linkedTasks = this.listReviewTasks();
    return {
      branch: this.git(["rev-parse", "--abbrev-ref", "HEAD"]) || "unknown",
      sha: this.git(["rev-parse", "HEAD"]) || "unknown",
      generatedAt: new Date().toISOString(),
      lanes: READINESS_LANES.map((lane) => this.resolveLane(lane.lane, lane.command)),
      openFindings: linkedTasks.filter((task) => task.status !== "done").length,
      linkedTasks,
      releaseProof: this.readReleaseProofSummary(),
    };
  }

  public importFindings(input: { findings: ReviewFindingInput[]; actorId?: string }): ReviewFindingImportResult {
    const importedAt = new Date().toISOString();
    const created: TaskRecord[] = [];
    const updated: TaskRecord[] = [];
    const skipped: ReviewFindingInput[] = [];
    const existingByKey = new Map(this.listReviewTasks().map((task) => [extractReviewKey(task), task]));

    for (const finding of input.findings) {
      const normalized = normalizeFinding(finding);
      if (!normalized) {
        skipped.push(finding);
        continue;
      }
      const key = buildFindingKey(normalized);
      const existing = existingByKey.get(key);
      if (existing) {
        const task = this.deps.taskLifecycleService.updateTask(existing.taskId, {
          description: renderFindingDescription(key, normalized),
          priority: normalized.priority ?? existing.priority,
          status: existing.status === "done" ? "review" : existing.status,
        });
        this.deps.taskLifecycleService.appendTaskActivity(task.taskId, {
          activityType: "diagnostic",
          agentId: input.actorId,
          message: `Review finding refreshed from ${normalized.source}.`,
          metadata: { reviewFindingKey: key, source: normalized.source, component: normalized.component },
        });
        appendEvidenceDeliverable(this.deps.taskLifecycleService, task.taskId, normalized);
        updated.push(task);
        existingByKey.set(key, task);
        continue;
      }
      const task = this.deps.taskLifecycleService.createTask({
        title: normalized.title,
        description: renderFindingDescription(key, normalized),
        status: "review",
        priority: normalized.priority ?? "normal",
        createdBy: "review-readiness",
      });
      this.deps.taskLifecycleService.appendTaskActivity(task.taskId, {
        activityType: "diagnostic",
        agentId: input.actorId,
        message: `Review finding imported from ${normalized.source}.`,
        metadata: { reviewFindingKey: key, source: normalized.source, component: normalized.component },
      });
      appendEvidenceDeliverable(this.deps.taskLifecycleService, task.taskId, normalized);
      created.push(task);
      existingByKey.set(key, task);
    }

    return { importedAt, created, updated, skipped };
  }

  private listReviewTasks(): TaskRecord[] {
    return this.deps.taskLifecycleService
      .listTasks(500, undefined, undefined, "all")
      .filter((task) => task.createdBy === "review-readiness" || Boolean(extractReviewKey(task)));
  }

  private resolveLane(lane: string, command: string): ReviewReadinessLane {
    const artifact = findLatestVerificationArtifact(this.deps.rootDir, lane);
    if (!artifact) {
      return { lane, status: "missing", rerunHint: command };
    }
    const ageMs = Date.now() - artifact.modifiedAt.getTime();
    return {
      lane,
      status: ageMs > CURRENT_PROOF_MAX_AGE_MS ? "stale" : "current",
      artifactRef: path.relative(this.deps.rootDir, artifact.path),
      lastRunAt: artifact.modifiedAt.toISOString(),
      rerunHint: command,
    };
  }

  private readReleaseProofSummary(): ReviewReadinessSummary["releaseProof"] | undefined {
    const certificatePath = path.join(this.deps.rootDir, "artifacts", "release", "release-certificate.json");
    if (!fs.existsSync(certificatePath)) {
      return undefined;
    }
    try {
      const certificate = JSON.parse(fs.readFileSync(certificatePath, "utf8")) as Record<string, unknown>;
      const artifacts = Array.isArray(certificate.releaseAssets) ? certificate.releaseAssets : [];
      const requiredLanes = Array.isArray(certificate.requiredLanes) ? certificate.requiredLanes : [];
      const acceptedCaveats = Array.isArray(certificate.acceptedFailures)
        ? certificate.acceptedFailures.map((item) => String(item))
        : [];
      const exactShaStatus = summarizeReleaseExactShaStatus(requiredLanes, readString(certificate.commit));
      return {
        sourceCertificate: "release-certificate.json",
        exactShaStatus,
        artifacts: artifacts.map((artifact) => {
          const record = isRecord(artifact) ? artifact : {};
          const name =
            readString(record.name) ??
            readString(record.fileName) ??
            readString(record.relativePath) ??
            readString(record.path) ??
            "unknown";
          return {
            name,
            platformArch: inferReleasePlatformArch(name),
            signatureStatus: inferReleaseSignatureStatus(record, artifacts),
            sha256:
              readString(record.sha256) ?? readString(record.digestSha256) ?? readString(record.hash) ?? "missing",
            sizeBytes: readNumber(record.sizeBytes) ?? readNumber(record.size) ?? 0,
            sourceWorkflow:
              readString(isRecord(certificate.releaseWorkflow) ? certificate.releaseWorkflow.name : undefined) ??
              "unknown",
            exactShaStatus,
            certificateInclusion: "included",
            acceptedCaveats,
          };
        }),
      };
    } catch {
      return undefined;
    }
  }

  private git(args: string[]): string | undefined {
    try {
      return execFileSync("git", args, {
        cwd: this.deps.rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return undefined;
    }
  }
}

function normalizeFinding(input: ReviewFindingInput): ReviewFindingInput | undefined {
  const title = input.title.trim();
  const source = input.source.trim();
  const component = input.component.trim();
  const files = input.files
    .map((file) => file.trim())
    .filter(Boolean)
    .sort();
  if (!title || !source || !component || files.length === 0) {
    return undefined;
  }
  return {
    ...input,
    title,
    source,
    component,
    files,
    summary: input.summary?.trim() || undefined,
    evidenceRef: input.evidenceRef?.trim() || undefined,
  };
}

function buildFindingKey(finding: ReviewFindingInput): string {
  return [finding.source, finding.component, finding.files.join(","), finding.title].join("::").toLowerCase();
}

function renderFindingDescription(key: string, finding: ReviewFindingInput): string {
  return [
    `${REVIEW_FINDING_PREFIX} ${key}`,
    "",
    finding.summary?.trim() || "Imported review finding awaiting triage.",
    "",
    `Source: ${finding.source}`,
    `Component: ${finding.component}`,
    `Files: ${finding.files.join(", ")}`,
    finding.evidenceRef ? `Evidence: ${finding.evidenceRef}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function extractReviewKey(task: TaskRecord): string | undefined {
  const line = task.description?.split(/\r?\n/).find((entry) => entry.startsWith(REVIEW_FINDING_PREFIX));
  return line?.slice(REVIEW_FINDING_PREFIX.length).trim();
}

function appendEvidenceDeliverable(
  taskLifecycleService: ReviewReadinessServiceDependencies["taskLifecycleService"],
  taskId: string,
  finding: ReviewFindingInput,
): void {
  if (!finding.evidenceRef) {
    return;
  }
  taskLifecycleService.appendTaskDeliverable(taskId, {
    deliverableType: finding.evidenceRef.startsWith("http") ? "url" : "artifact",
    title: "Review evidence",
    path: finding.evidenceRef,
    description: `Evidence for ${finding.source} review finding.`,
  });
}

function findLatestVerificationArtifact(rootDir: string, lane: string): { path: string; modifiedAt: Date } | undefined {
  const verificationDir = path.join(rootDir, "artifacts", "verification");
  if (!fs.existsSync(verificationDir)) {
    return undefined;
  }
  const entries = fs
    .readdirSync(verificationDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const artifactPath = path.join(verificationDir, entry.name);
      return { path: artifactPath, modifiedAt: fs.statSync(artifactPath).mtime };
    })
    .filter((entry) => artifactMatchesLane(entry.path, lane))
    .sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  return entries[0];
}

function artifactMatchesLane(artifactPath: string, lane: string): boolean {
  if (path.basename(artifactPath).includes(lane)) {
    return true;
  }
  const manifestPath = path.join(artifactPath, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return false;
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      lane?: string;
      scenarios?: Array<{ id?: string; title?: string; subsystem?: string; status?: string }>;
    };
    if (manifest.lane === lane) {
      return true;
    }
    return (manifest.scenarios ?? []).some((scenario) => {
      const haystack = `${scenario.id ?? ""} ${scenario.title ?? ""} ${scenario.subsystem ?? ""}`.toLowerCase();
      return scenario.status === "passed" && haystack.includes(lane.toLowerCase());
    });
  } catch {
    return false;
  }
}

function summarizeReleaseExactShaStatus(requiredLanes: unknown[], commit: string | undefined) {
  if (!commit) {
    return "unknown";
  }
  if (!requiredLanes.length) {
    return "unknown";
  }
  const matching = requiredLanes.filter((lane) => {
    if (!isRecord(lane)) {
      return false;
    }
    const directRun = isRecord(lane.directRun) ? lane.directRun : {};
    const releaseProofRun = isRecord(lane.releaseProofRun) ? lane.releaseProofRun : {};
    return (
      readString(directRun.headSha) === commit ||
      readString(directRun.head_sha) === commit ||
      readString(releaseProofRun.headSha) === commit ||
      readString(releaseProofRun.head_sha) === commit
    );
  }).length;
  return matching === requiredLanes.length ? "exact" : matching > 0 ? "partial" : "missing";
}

function inferReleaseSignatureStatus(
  record: Record<string, unknown>,
  artifacts: unknown[],
): "signed" | "unsigned" | "experimental" {
  if (record.signature || record.signaturePath || record.certificatePath) {
    return "signed";
  }
  const name = readString(record.name) ?? readString(record.fileName) ?? readString(record.relativePath) ?? "";
  if (name.endsWith(".sig") || name.endsWith(".pem")) {
    return "signed";
  }
  const siblingNames = new Set(
    artifacts
      .map((artifact) => (isRecord(artifact) ? artifact : {}))
      .map(
        (artifact) =>
          readString(artifact.name) ?? readString(artifact.fileName) ?? readString(artifact.relativePath) ?? "",
      ),
  );
  if (siblingNames.has(`${name}.sig`) || siblingNames.has(`${name}.pem`) || siblingNames.has(`${name}.cert.pem`)) {
    return "signed";
  }
  return /experimental|preview/i.test(name) ? "experimental" : "unsigned";
}

function inferReleasePlatformArch(name: string): string {
  const lower = name.toLowerCase();
  const platform = lower.includes("win")
    ? "windows"
    : lower.includes("mac") || lower.includes("darwin") || lower.endsWith(".dmg")
      ? "macos"
      : lower.includes("linux") || lower.endsWith(".tar.gz")
        ? "linux"
        : "unknown";
  const arch =
    lower.includes("arm64") || lower.includes("aarch64")
      ? "arm64"
      : lower.includes("x64") || lower.includes("amd64")
        ? "x64"
        : "unknown";
  return `${platform}/${arch}`;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
