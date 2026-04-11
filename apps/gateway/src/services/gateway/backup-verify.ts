import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type {
  BackupManifestContractCoverageRecord,
  BackupManifestRecord,
  BackupVerifyContractCoverageRecord,
  BackupVerifyContractSection,
  BackupVerifyIssue,
  BackupVerifyResponse,
} from "@goatcitadel/contracts";

export async function verifyBackupAtPath(backupPath: string): Promise<BackupVerifyResponse> {
  const resolvedBackupPath = path.resolve(backupPath);
  const issues: BackupVerifyIssue[] = [];
  const manifestPath = path.join(resolvedBackupPath, "manifest.json");
  const payloadDir = path.join(resolvedBackupPath, "payload");

  let manifest: BackupManifestRecord | undefined;
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    manifest = parseBackupManifest(raw, issues);
  } catch (error) {
    issues.push({
      code: "manifest_missing",
      message: `Backup manifest is missing or unreadable: ${(error as Error).message}`,
      path: "manifest.json",
    });
  }

  const payloadFiles = await collectPayloadFiles(payloadDir, issues);
  const payloadVerifiedPaths = new Set<string>();
  let filesVerified = 0;

  if (manifest) {
    const seenPaths = new Set<string>();
    for (const file of manifest.files) {
      const normalizedPath = normalizeBackupRelativePath(file.path);
      if (!normalizedPath) {
        issues.push({
          code: "manifest_invalid_path",
          message: `Manifest file path is invalid: ${file.path}`,
          path: file.path,
        });
        continue;
      }
      if (seenPaths.has(normalizedPath)) {
        issues.push({
          code: "manifest_duplicate_path",
          message: `Manifest contains duplicate file path: ${normalizedPath}`,
          path: normalizedPath,
        });
        continue;
      }
      seenPaths.add(normalizedPath);

      const fullPath = path.join(payloadDir, normalizedPath);
      ensurePathWithinRoot(fullPath, payloadDir);
      if (!payloadFiles.has(normalizedPath)) {
        issues.push({
          code: "payload_missing_file",
          message: `Payload file is missing: ${normalizedPath}`,
          path: normalizedPath,
        });
        continue;
      }

      const bytes = await fs.readFile(fullPath);
      if (bytes.length !== file.sizeBytes) {
        issues.push({
          code: "payload_size_mismatch",
          message: `Payload file size does not match manifest for ${normalizedPath}.`,
          path: normalizedPath,
        });
        continue;
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== file.sha256) {
        issues.push({
          code: "payload_sha256_mismatch",
          message: `Payload file checksum does not match manifest for ${normalizedPath}.`,
          path: normalizedPath,
        });
        continue;
      }
      filesVerified += 1;
      payloadVerifiedPaths.add(normalizedPath);
      payloadFiles.delete(normalizedPath);
    }

    for (const extraPath of payloadFiles.keys()) {
      issues.push({
        code: "payload_untracked_file",
        message: `Payload contains a file not declared in the manifest: ${extraPath}`,
        path: extraPath,
      });
    }
  }

  const contractCoverage = buildBackupVerifyContractCoverage(manifest, payloadVerifiedPaths, issues);
  const verified = issues.length === 0;
  const contractVerified =
    verified && allContractSectionsVerified(contractCoverage) && !contractCoverage.legacyManifest;

  return {
    backupPath: resolvedBackupPath,
    backupId: manifest?.backupId,
    verified,
    contractVerified,
    filesVerified,
    issues,
    manifest,
    contractCoverage,
  };
}

function parseBackupManifest(raw: string, issues: BackupVerifyIssue[]): BackupManifestRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    issues.push({
      code: "manifest_invalid_json",
      message: `Backup manifest is not valid JSON: ${(error as Error).message}`,
      path: "manifest.json",
    });
    return undefined;
  }

  if (!parsed || typeof parsed !== "object") {
    issues.push({
      code: "manifest_invalid_shape",
      message: "Backup manifest must be a JSON object.",
      path: "manifest.json",
    });
    return undefined;
  }

  const record = parsed as Partial<BackupManifestRecord>;
  if (
    typeof record.backupId !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.appVersion !== "string" ||
    typeof record.rootDir !== "string" ||
    !Array.isArray(record.files)
  ) {
    issues.push({
      code: "manifest_invalid_shape",
      message: "Backup manifest is missing required fields.",
      path: "manifest.json",
    });
    return undefined;
  }

  const files = [];
  for (const entry of record.files) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.path !== "string" ||
      typeof entry.sizeBytes !== "number" ||
      !Number.isFinite(entry.sizeBytes) ||
      typeof entry.sha256 !== "string"
    ) {
      issues.push({
        code: "manifest_invalid_file_record",
        message: "Backup manifest contains an invalid file record.",
        path: "manifest.json",
      });
      continue;
    }
    files.push({
      path: entry.path,
      sizeBytes: Math.max(0, Math.floor(entry.sizeBytes)),
      sha256: entry.sha256,
    });
  }

  return {
    backupId: record.backupId,
    createdAt: record.createdAt,
    appVersion: record.appVersion,
    gitRef: typeof record.gitRef === "string" ? record.gitRef : undefined,
    rootDir: record.rootDir,
    files,
    contractCoverage: parseManifestContractCoverage(record.contractCoverage, issues),
  };
}

function parseManifestContractCoverage(
  input: unknown,
  issues: BackupVerifyIssue[],
): BackupManifestContractCoverageRecord | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!input || typeof input !== "object") {
    issues.push({
      code: "manifest_invalid_contract_coverage",
      message: "Backup manifest contractCoverage must be an object when present.",
      path: "manifest.json",
    });
    return undefined;
  }
  const record = input as Partial<BackupManifestContractCoverageRecord>;
  const minimumSet = record.minimumSet as Partial<BackupManifestContractCoverageRecord["minimumSet"]> | undefined;
  if (
    record.contractVersion !== "1.0" ||
    !minimumSet ||
    !Array.isArray(minimumSet.databasePaths) ||
    !Array.isArray(minimumSet.transcriptPaths) ||
    !Array.isArray(minimumSet.auditPaths) ||
    !Array.isArray(minimumSet.configPaths)
  ) {
    issues.push({
      code: "manifest_invalid_contract_coverage",
      message: "Backup manifest contractCoverage is missing required minimum-set metadata.",
      path: "manifest.json",
    });
    return undefined;
  }
  return {
    contractVersion: "1.0",
    minimumSet: {
      databasePaths: normalizeContractPaths(minimumSet.databasePaths, issues),
      transcriptPaths: normalizeContractPaths(minimumSet.transcriptPaths, issues),
      auditPaths: normalizeContractPaths(minimumSet.auditPaths, issues),
      configPaths: normalizeContractPaths(minimumSet.configPaths, issues),
    },
  };
}

function normalizeContractPaths(input: unknown[], issues: BackupVerifyIssue[]): string[] {
  const normalized = new Set<string>();
  for (const value of input) {
    if (typeof value !== "string") {
      issues.push({
        code: "manifest_invalid_contract_coverage",
        message: "Backup manifest contractCoverage paths must be strings.",
        path: "manifest.json",
      });
      continue;
    }
    const normalizedPath = normalizeBackupRelativePath(value);
    if (!normalizedPath) {
      issues.push({
        code: "manifest_invalid_contract_coverage",
        message: `Backup manifest contractCoverage contains an invalid path: ${value}`,
        path: "manifest.json",
      });
      continue;
    }
    normalized.add(normalizedPath);
  }
  return [...normalized].sort((left, right) => left.localeCompare(right));
}

async function collectPayloadFiles(payloadDir: string, issues: BackupVerifyIssue[]): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  try {
    await fs.access(payloadDir);
  } catch (error) {
    issues.push({
      code: "payload_missing",
      message: `Backup payload directory is missing or unreadable: ${(error as Error).message}`,
      path: "payload",
    });
    return files;
  }

  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const relativePath = path.relative(payloadDir, fullPath).replaceAll("\\", "/");
      const normalizedPath = normalizeBackupRelativePath(relativePath);
      if (!normalizedPath) {
        issues.push({
          code: "payload_invalid_path",
          message: `Payload contains an invalid file path: ${relativePath}`,
          path: relativePath,
        });
        continue;
      }
      ensurePathWithinRoot(fullPath, payloadDir);
      files.set(normalizedPath, fullPath);
    }
  };

  await walk(payloadDir);
  return files;
}

function buildBackupVerifyContractCoverage(
  manifest: BackupManifestRecord | undefined,
  payloadVerifiedPaths: Set<string>,
  issues: BackupVerifyIssue[],
): BackupVerifyContractCoverageRecord {
  const reasons = new Set<string>();
  if (!manifest) {
    reasons.add("manifest_missing_or_invalid");
    return {
      contractVersion: "1.0",
      legacyManifest: false,
      reasons: [...reasons],
      minimumSet: {
        database: buildContractSection([], payloadVerifiedPaths),
        transcripts: buildContractSection([], payloadVerifiedPaths),
        audit: buildContractSection([], payloadVerifiedPaths),
        config: buildContractSection([], payloadVerifiedPaths),
      },
    };
  }

  const legacyManifest = !manifest.contractCoverage;
  if (legacyManifest) {
    reasons.add("legacy_manifest_missing_contract_coverage");
  }
  if (issues.length > 0) {
    reasons.add("payload_integrity_failed");
  }

  const database = buildContractSection(
    manifest.contractCoverage?.minimumSet.databasePaths ?? [],
    payloadVerifiedPaths,
  );
  const transcripts = buildContractSection(
    manifest.contractCoverage?.minimumSet.transcriptPaths ?? [],
    payloadVerifiedPaths,
  );
  const audit = buildContractSection(manifest.contractCoverage?.minimumSet.auditPaths ?? [], payloadVerifiedPaths);
  const config = buildContractSection(manifest.contractCoverage?.minimumSet.configPaths ?? [], payloadVerifiedPaths);

  appendContractReasons(reasons, "database", database);
  appendContractReasons(reasons, "transcripts", transcripts);
  appendContractReasons(reasons, "audit", audit);
  appendContractReasons(reasons, "config", config);

  return {
    contractVersion: "1.0",
    legacyManifest,
    reasons: [...reasons],
    minimumSet: {
      database,
      transcripts,
      audit,
      config,
    },
  };
}

function buildContractSection(expectedPaths: string[], payloadVerifiedPaths: Set<string>): BackupVerifyContractSection {
  const normalizedExpected = [...new Set(expectedPaths)].sort((left, right) => left.localeCompare(right));
  const verifiedPaths = normalizedExpected.filter((item) => payloadVerifiedPaths.has(item));
  const missingPaths = normalizedExpected.filter((item) => !payloadVerifiedPaths.has(item));
  return {
    expectedPaths: normalizedExpected,
    verifiedPaths,
    missingPaths,
    verified: normalizedExpected.length > 0 && missingPaths.length === 0,
  };
}

function appendContractReasons(
  reasons: Set<string>,
  sectionName: "database" | "transcripts" | "audit" | "config",
  section: BackupVerifyContractSection,
): void {
  if (section.expectedPaths.length === 0) {
    reasons.add(`minimum_set_${sectionName}_missing`);
    return;
  }
  if (section.missingPaths.length > 0) {
    reasons.add(`minimum_set_${sectionName}_incomplete`);
  }
}

function allContractSectionsVerified(contractCoverage: BackupVerifyContractCoverageRecord): boolean {
  return (
    contractCoverage.minimumSet.database.verified &&
    contractCoverage.minimumSet.transcripts.verified &&
    contractCoverage.minimumSet.audit.verified &&
    contractCoverage.minimumSet.config.verified
  );
}

function normalizeBackupRelativePath(input: string): string | undefined {
  const normalized = input.replaceAll("\\", "/").trim();
  if (!normalized || normalized.startsWith("/")) {
    return undefined;
  }
  if (path.isAbsolute(normalized)) {
    return undefined;
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return undefined;
  }
  return segments.join("/");
}

function ensurePathWithinRoot(targetPath: string, rootDir: string): void {
  const relative = path.relative(rootDir, targetPath);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error(`Path escapes allowed root: ${targetPath}`);
}
