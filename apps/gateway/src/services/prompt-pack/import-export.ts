import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import path from "node:path";
import type {
  PromptPackExportRecord,
  PromptPackPromptfooImportPreviewResponse,
  PromptPackRecord,
  PromptPackReportRecord,
  PromptPackTestRecord,
} from "@goatcitadel/contracts";
import { DEFAULT_PROMPT_PACK_EXPORT_ARCHIVE_DIR, DEFAULT_PROMPT_PACK_EXPORT_DIR } from "../prompt-pack-policy.js";

interface PromptfooLikeConfigPreview {
  promptCount: number;
  providerCount: number;
  testCount: number;
  reviewAssets: NonNullable<PromptPackPromptfooImportPreviewResponse["reviewAssets"]>;
  warnings: string[];
  errors: string[];
}

export function sanitizePromptPackExportFileName(input: string): string {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "prompt-pack";
}

export function buildPromptfooExportPayload(report: PromptPackReportRecord, generatedAt: string) {
  const provider = "goatcitadel://operator-provided-provider";
  return {
    version: "promptfoo.config.v1",
    description: `GoatCitadel read-only Promptfoo export for ${report.pack.name}`,
    prompts: [
      {
        id: "goatcitadel_prompt_pack_prompt",
        raw: "{{prompt}}",
      },
    ],
    providers: [provider],
    tests: report.tests.map((test) => ({
      description: `${test.code}: ${test.title}`,
      vars: {
        prompt: test.prompt,
      },
      metadata: {
        source: "goatcitadel.prompt_pack",
        packId: report.pack.packId,
        testId: test.testId,
        testCode: test.code,
        mode: test.mode,
        toolTier: test.toolTier,
      },
    })),
    metadata: {
      source: "goatcitadel.prompt_pack",
      packId: report.pack.packId,
      packName: report.pack.name,
      generatedAt,
      readOnly: true,
      sideEffectPosture: "export_only",
      providerExecution: "operator_config_required",
      note: "This export is a Promptfoo-compatible planning artifact. GoatCitadel does not run providers or mutate prompt packs when generating it.",
    },
  };
}

export function buildPromptfooExportInterop(
  tests: PromptPackTestRecord[],
  pack?: PromptPackRecord,
): PromptPackExportRecord["interop"] {
  const assertionCount = tests.reduce((count, test) => {
    const expectedSignals = test.diagnosticMetadata?.expectedRuntimeSignals?.length ?? 0;
    const likelyFailures = test.diagnosticMetadata?.likelyFailureClasses?.length ?? 0;
    return count + Math.max(1, expectedSignals + likelyFailures);
  }, 0);
  const toolUseExpectationCount = tests.filter((test) => test.toolTier && test.toolTier !== "no-tools").length;
  return {
    promptfoo: {
      compatible: true,
      configVersion: "promptfoo.config.v1",
      promptCount: 1,
      providerCount: 1,
      testCount: tests.length,
      assertionCount,
      runRowCount: 0,
      traceLinkCount: 0,
      toolUseExpectationCount,
      redactionPosture: "redacted_export",
      seededSampling: {
        deterministic: true,
        seed: pack?.packId,
        sampleCount: tests.length,
      },
      goatcitadelProvenance: pack
        ? {
            packId: pack.packId,
            exportEndpoint: `/api/v1/prompt-packs/${pack.packId}/export?format=promptfoo`,
            importedMaterialCallable: false,
            sideEffectPosture: "export_only",
          }
        : undefined,
      notes: [
        "Export is read-only JSON and uses an operator-provided provider placeholder.",
        "GoatCitadel does not run Promptfoo or call providers while exporting.",
        "Imported Promptfoo-shaped material is preview-only evidence and is not callable or auto-promoted.",
      ],
    },
  };
}

export function parsePromptfooLikeConfig(content: string): PromptfooLikeConfigPreview {
  const trimmed = content.trim();
  if (!trimmed) {
    return {
      promptCount: 0,
      providerCount: 0,
      testCount: 0,
      reviewAssets: [],
      warnings: [],
      errors: ["Promptfoo import preview requires non-empty content."],
    };
  }
  const probeCorpusPreview = parseGarakProbeCorpusPreview(trimmed);
  if (probeCorpusPreview) {
    return probeCorpusPreview;
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return parsePromptfooJsonPreview(trimmed);
  }
  return parsePromptfooYamlPreview(trimmed);
}

export function resolvePromptPackExportPath(rootDir: string, pack: PromptPackRecord): string {
  const dir = path.join(rootDir, DEFAULT_PROMPT_PACK_EXPORT_DIR);
  const baseName = sanitizePromptPackExportFileName(pack.name || pack.packId || "prompt-pack");
  const packSuffix = sanitizePromptPackExportFileName(pack.packId).slice(0, 18);
  return path.join(dir, `${baseName}-${packSuffix}-latest.md`);
}

export function resolvePromptPackPromptfooExportPath(rootDir: string, pack: PromptPackRecord): string {
  const dir = path.join(rootDir, DEFAULT_PROMPT_PACK_EXPORT_DIR);
  const baseName = sanitizePromptPackExportFileName(pack.name || pack.packId || "prompt-pack");
  const packSuffix = sanitizePromptPackExportFileName(pack.packId).slice(0, 18);
  return path.join(dir, `${baseName}-${packSuffix}-promptfoo-latest.json`);
}

export function resolvePromptPackExportArchiveDir(rootDir: string): string {
  return path.join(rootDir, DEFAULT_PROMPT_PACK_EXPORT_DIR, DEFAULT_PROMPT_PACK_EXPORT_ARCHIVE_DIR);
}

export function resolvePromptPackSnapshotPath(input: {
  rootDir: string;
  report: PromptPackReportRecord;
  generatedAt: string;
  providerModelSlug: string;
  executionStyleSlug: string;
}): string {
  const archiveDir = resolvePromptPackExportArchiveDir(input.rootDir);
  const baseName = sanitizePromptPackExportFileName(
    input.report.pack.name || input.report.pack.packId || "prompt-pack",
  );
  const timestamp = formatPromptPackSnapshotTimestamp(input.generatedAt);
  const requested = path.join(
    archiveDir,
    `${baseName}_${timestamp}_${input.providerModelSlug}_${input.executionStyleSlug}.md`,
  );
  return resolveUniquePromptPackSnapshotPath(requested);
}

export function resolvePromptPackPromptfooSnapshotPath(input: {
  rootDir: string;
  pack: PromptPackRecord;
  generatedAt: string;
}): string {
  const archiveDir = resolvePromptPackExportArchiveDir(input.rootDir);
  const baseName = sanitizePromptPackExportFileName(input.pack.name || input.pack.packId || "prompt-pack");
  const timestamp = formatPromptPackSnapshotTimestamp(input.generatedAt);
  const requested = path.join(archiveDir, `${baseName}_${timestamp}_promptfoo.json`);
  return resolveUniquePromptPackSnapshotPath(requested);
}

export function readPromptPackExportRecord(rootDir: string, pack: PromptPackRecord): PromptPackExportRecord {
  const filePath = resolvePromptPackExportPath(rootDir, pack);
  const archiveDir = resolvePromptPackExportArchiveDir(rootDir);
  const snapshotPrefix = `${sanitizePromptPackExportFileName(pack.name || pack.packId || "prompt-pack")}_`;
  const latestSnapshot = readLatestPromptPackSnapshot(archiveDir, snapshotPrefix);
  const snapshotCount = countPromptPackSnapshots(archiveDir, snapshotPrefix);
  const snapshotFields = latestSnapshot
    ? {
        latestSnapshotPath: latestSnapshot.path,
        latestSnapshotExists: true,
        latestSnapshotSizeBytes: latestSnapshot.sizeBytes,
        latestSnapshotUpdatedAt: latestSnapshot.updatedAt,
      }
    : {
        latestSnapshotExists: false,
      };
  try {
    const stat = fsSync.statSync(filePath);
    return {
      packId: pack.packId,
      format: "goatcitadel",
      path: filePath,
      contentType: "text/markdown",
      latestPath: filePath,
      archiveDir,
      exists: true,
      sizeBytes: stat.size,
      updatedAt: new Date(stat.mtimeMs).toISOString(),
      snapshotCount,
      ...snapshotFields,
    };
  } catch {
    return {
      packId: pack.packId,
      format: "goatcitadel",
      path: filePath,
      contentType: "text/markdown",
      latestPath: filePath,
      archiveDir,
      exists: false,
      sizeBytes: 0,
      snapshotCount,
      ...snapshotFields,
    };
  }
}

export function readPromptPackPromptfooExportRecord(input: {
  rootDir: string;
  pack: PromptPackRecord;
  tests: PromptPackTestRecord[];
}): PromptPackExportRecord {
  const filePath = resolvePromptPackPromptfooExportPath(input.rootDir, input.pack);
  const archiveDir = resolvePromptPackExportArchiveDir(input.rootDir);
  const snapshotPrefix = `${sanitizePromptPackExportFileName(input.pack.name || input.pack.packId || "prompt-pack")}_`;
  const latestSnapshot = readLatestPromptPackSnapshot(archiveDir, snapshotPrefix, ".json", "_promptfoo");
  const snapshotCount = countPromptPackSnapshots(archiveDir, snapshotPrefix, ".json", "_promptfoo");
  const interop = buildPromptfooExportInterop(input.tests, input.pack);
  const snapshotFields = latestSnapshot
    ? {
        latestSnapshotPath: latestSnapshot.path,
        latestSnapshotExists: true,
        latestSnapshotSizeBytes: latestSnapshot.sizeBytes,
        latestSnapshotUpdatedAt: latestSnapshot.updatedAt,
      }
    : {
        latestSnapshotExists: false,
      };
  try {
    const stat = fsSync.statSync(filePath);
    return {
      packId: input.pack.packId,
      format: "promptfoo",
      path: filePath,
      contentType: "application/json",
      latestPath: filePath,
      archiveDir,
      exists: true,
      sizeBytes: stat.size,
      updatedAt: new Date(stat.mtimeMs).toISOString(),
      snapshotCount,
      interop,
      ...snapshotFields,
    };
  } catch {
    return {
      packId: input.pack.packId,
      format: "promptfoo",
      path: filePath,
      contentType: "application/json",
      latestPath: filePath,
      archiveDir,
      exists: false,
      sizeBytes: 0,
      snapshotCount,
      interop,
      ...snapshotFields,
    };
  }
}

function readLatestPromptPackSnapshot(
  archiveDir: string,
  snapshotPrefix: string,
  extension = ".md",
  nameIncludes?: string,
): { path: string; sizeBytes: number; updatedAt: string } | undefined {
  try {
    const entries = fsSync
      .readdirSync(archiveDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.startsWith(snapshotPrefix) &&
          entry.name.toLowerCase().endsWith(extension) &&
          (!nameIncludes || entry.name.includes(nameIncludes)),
      )
      .map((entry) => {
        const filePath = path.join(archiveDir, entry.name);
        const stat = fsSync.statSync(filePath);
        return {
          path: filePath,
          sizeBytes: stat.size,
          updatedAt: new Date(stat.mtimeMs).toISOString(),
          mtimeMs: stat.mtimeMs,
        };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
    return entries[0];
  } catch {
    return undefined;
  }
}

function countPromptPackSnapshots(
  archiveDir: string,
  snapshotPrefix: string,
  extension = ".md",
  nameIncludes?: string,
): number {
  try {
    return fsSync
      .readdirSync(archiveDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.startsWith(snapshotPrefix) &&
          entry.name.toLowerCase().endsWith(extension) &&
          (!nameIncludes || entry.name.includes(nameIncludes)),
      ).length;
  } catch {
    return 0;
  }
}

function parsePromptfooJsonPreview(content: string): PromptfooLikeConfigPreview {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) {
      return {
        promptCount: 0,
        providerCount: 0,
        testCount: 0,
        reviewAssets: [],
        warnings: [],
        errors: ["Promptfoo preview expected a JSON object."],
      };
    }
    const promptCount = countPromptfooCollection(parsed.prompts);
    const providerCount = countPromptfooCollection(parsed.providers);
    const testCount = countPromptfooCollection(parsed.tests);
    const redTeamAssetCount = countPromptfooRedTeamAssets(parsed);
    const errors = [];
    if (promptCount === 0) {
      errors.push("Promptfoo preview could not find prompts.");
    }
    if (testCount === 0) {
      errors.push("Promptfoo preview could not find tests.");
    }
    return {
      promptCount,
      providerCount,
      testCount,
      reviewAssets:
        redTeamAssetCount > 0
          ? [
              {
                source: "promptfoo_redteam",
                assetKind: "red_team_case",
                count: redTeamAssetCount,
                callable: false,
                activationRequired: true,
                note: "Promptfoo red-team material is previewed as review-only eval assets until an operator imports and activates it.",
              },
            ]
          : [],
      warnings:
        providerCount === 0
          ? [
              "No providers were declared. Preview remains valid for shape review but cannot run without operator config.",
            ]
          : [],
      errors,
    };
  } catch (error) {
    return {
      promptCount: 0,
      providerCount: 0,
      testCount: 0,
      reviewAssets: [],
      warnings: [],
      errors: [`Invalid JSON Promptfoo preview: ${(error as Error).message}`],
    };
  }
}

function parsePromptfooYamlPreview(content: string): PromptfooLikeConfigPreview {
  const promptSection = readSimpleYamlCollectionCount(content, "prompts");
  const providerSection = readSimpleYamlCollectionCount(content, "providers");
  const testSection = readSimpleYamlCollectionCount(content, "tests");
  const errors = [];
  if (promptSection === 0) {
    errors.push("Promptfoo preview could not find prompts.");
  }
  if (testSection === 0) {
    errors.push("Promptfoo preview could not find tests.");
  }
  return {
    promptCount: promptSection,
    providerCount: providerSection,
    testCount: testSection,
    reviewAssets: content.toLowerCase().includes("redteam")
      ? [
          {
            source: "promptfoo_redteam",
            assetKind: "red_team_case",
            count: Math.max(1, testSection),
            callable: false,
            activationRequired: true,
            note: "Promptfoo red-team YAML markers are previewed as review-only eval assets.",
          },
        ]
      : [],
    warnings: [
      "YAML preview uses a dependency-free structural scan. Import before execution should be reviewed by the operator.",
      ...(providerSection === 0 ? ["No providers were declared."] : []),
    ],
    errors,
  };
}

function countPromptfooCollection(value: unknown): number {
  if (Array.isArray(value)) {
    return value.length;
  }
  if (isRecord(value)) {
    return Object.keys(value).length;
  }
  return typeof value === "string" && value.trim() ? 1 : 0;
}

function parseGarakProbeCorpusPreview(content: string): PromptfooLikeConfigPreview | undefined {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return undefined;
  }
  const parsedRows: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) {
        return undefined;
      }
      parsedRows.push(parsed);
    } catch {
      return undefined;
    }
  }
  const probeRows = parsedRows.filter((row) =>
    ["probe", "detector", "goal", "prompt", "payload"].some((key) => typeof row[key] === "string"),
  );
  if (probeRows.length === 0) {
    return undefined;
  }
  return {
    promptCount: probeRows.filter((row) => typeof row.prompt === "string" || typeof row.payload === "string").length,
    providerCount: 0,
    testCount: probeRows.length,
    reviewAssets: [
      {
        source: "garak_probe_corpus",
        assetKind: "probe_payload",
        count: probeRows.length,
        callable: false,
        activationRequired: true,
        note: "Garak-shaped probe rows are previewed as non-callable payload assets; GoatCitadel does not run garak during preview.",
      },
    ],
    warnings: [
      "Garak-style JSONL preview treats rows as probe payload candidates only; import and activation remain explicit operator steps.",
      "No providers were declared.",
    ],
    errors: [],
  };
}

function countPromptfooRedTeamAssets(parsed: Record<string, unknown>): number {
  const redteam = isRecord(parsed.redteam) ? parsed.redteam : isRecord(parsed.redTeam) ? parsed.redTeam : undefined;
  if (!redteam) {
    return 0;
  }
  const total =
    countPromptfooCollection(redteam.plugins) +
    countPromptfooCollection(redteam.strategies) +
    countPromptfooCollection(redteam.tests);
  return total > 0 ? total : 1;
}

function readSimpleYamlCollectionCount(content: string, key: string): number {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^${key}:\\s*$`, "i").test(line.trim()));
  if (start < 0) {
    return 0;
  }
  let count = 0;
  for (const line of lines.slice(start + 1)) {
    if (/^\S[^:]*:\s*$/.test(line)) {
      break;
    }
    if (/^\s*-\s+/.test(line)) {
      count += 1;
    }
  }
  return count;
}

function formatPromptPackSnapshotTimestamp(value: string): string {
  const parsed = new Date(value);
  const iso = Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
  return iso
    .replace(/\.\d{3}Z$/, "Z")
    .replace("T", "_")
    .replace(/:/g, "-");
}

function resolveUniquePromptPackSnapshotPath(requestedPath: string): string {
  if (!fsSync.existsSync(requestedPath)) {
    return requestedPath;
  }
  const dir = path.dirname(requestedPath);
  const ext = path.extname(requestedPath);
  const baseName = path.basename(requestedPath, ext);
  for (let index = 2; index < 1000; index += 1) {
    const candidate = path.join(dir, `${baseName}-${index}${ext}`);
    if (!fsSync.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(dir, `${baseName}-${randomUUID().slice(0, 8)}${ext}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
