import { createHash } from "node:crypto";
import {
  EXTERNAL_SOURCE_LIMITS,
  EXTERNAL_SOURCE_SCHEMA_VERSION,
  type ExternalSourceCatalogItem,
} from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import type { ExternalSourceReadResult } from "../external-source-reader.js";
import { claudeMemoryExternalSourceAdapter } from "./claude-memory-adapter.js";
import { claudeSessionExternalSourceAdapter } from "./claude-session-adapter.js";
import { codexMemoryExternalSourceAdapter } from "./codex-memory-adapter.js";
import { codexRolloutExternalSourceAdapter } from "./codex-rollout-adapter.js";
import {
  SYNTHETIC_CLAUDE_EXCLUDED_SENTINELS,
  SYNTHETIC_CLAUDE_MEMORY_MARKDOWN,
  SYNTHETIC_CLAUDE_PRODUCER_VERSION,
  SYNTHETIC_CLAUDE_SESSION_JSONL,
  SYNTHETIC_CLAUDE_VISIBLE_ASSISTANT_TEXT,
  SYNTHETIC_CLAUDE_VISIBLE_USER_TEXT,
  SYNTHETIC_CODEX_COMPACTION_TEXT,
  SYNTHETIC_CODEX_EXCLUDED_SENTINELS,
  SYNTHETIC_CODEX_MEMORY_MARKDOWN,
  SYNTHETIC_CODEX_PRODUCER_VERSION,
  SYNTHETIC_CODEX_ROLLOUT_JSONL,
  SYNTHETIC_CODEX_VISIBLE_ASSISTANT_TEXT,
  SYNTHETIC_CODEX_VISIBLE_USER_TEXT,
  SYNTHETIC_SESSION_ID,
} from "./fixtures/synthetic-fixtures.js";
import {
  EXTERNAL_SOURCE_UNVERSIONED_MARKDOWN_PRODUCER,
  ExternalSourceAdapterError,
  computeLineage,
  type ExternalSourceAdapterErrorCode,
} from "./internal.js";
import {
  ExternalSourceAdapterRegistry,
  type ExternalSourceAdapter,
  type ExternalSourceAdapterInspection,
  type ExternalSourceAdapterPolicyView,
} from "./types.js";

const CODEX_FILENAME = `rollout-2026-07-14T00-00-00-${SYNTHETIC_SESSION_ID}.jsonl`;
const CODEX_PATH = `sessions/2026/07/14/${CODEX_FILENAME}`;
const CODEX_ARCHIVED_PATH = `archived_sessions/${CODEX_FILENAME}`;
const CLAUDE_PATH = `projects/synthetic-project/${SYNTHETIC_SESSION_ID}.jsonl`;

describe("HX-407 fixed external source adapters", () => {
  it("recognizes only the frozen Codex and Claude path families", () => {
    expect(
      new ExternalSourceAdapterRegistry([
        codexRolloutExternalSourceAdapter,
        codexMemoryExternalSourceAdapter,
        claudeSessionExternalSourceAdapter,
        claudeMemoryExternalSourceAdapter,
      ]),
    ).toBeInstanceOf(ExternalSourceAdapterRegistry);
    expect(codexRolloutExternalSourceAdapter.recognizes(CODEX_PATH)).toBe(true);
    expect(codexRolloutExternalSourceAdapter.recognizes(CODEX_ARCHIVED_PATH)).toBe(true);
    expect(codexRolloutExternalSourceAdapter.recognizes("history.jsonl")).toBe(false);
    expect(codexRolloutExternalSourceAdapter.recognizes("archived_sessions/credentials.jsonl")).toBe(false);
    expect(codexRolloutExternalSourceAdapter.recognizes(`sessions/2026/07/14/${SYNTHETIC_SESSION_ID}.jsonl`)).toBe(
      false,
    );
    expect(
      codexRolloutExternalSourceAdapter.recognizes(
        `sessions/2026/07/13/rollout-2026-07-14T00-00-00-${SYNTHETIC_SESSION_ID}.jsonl`,
      ),
    ).toBe(false);
    expect(codexRolloutExternalSourceAdapter.recognizes("sessions/2026/02/30/session.jsonl")).toBe(false);
    expect(codexRolloutExternalSourceAdapter.recognizes("sessions/2026/07/14/../auth.jsonl")).toBe(false);
    expect(codexRolloutExternalSourceAdapter.recognizes("sessions\\2026\\07\\14\\session.jsonl")).toBe(false);

    expect(codexMemoryExternalSourceAdapter.recognizes("MEMORY.md")).toBe(true);
    expect(codexMemoryExternalSourceAdapter.recognizes("memory_summary.md")).toBe(true);
    expect(codexMemoryExternalSourceAdapter.recognizes("rollout_summaries/synthetic-summary.md")).toBe(true);
    expect(codexMemoryExternalSourceAdapter.recognizes("skills/private/SKILL.md")).toBe(false);
    expect(codexMemoryExternalSourceAdapter.recognizes("auth.json")).toBe(false);

    expect(claudeSessionExternalSourceAdapter.recognizes(CLAUDE_PATH)).toBe(true);
    expect(
      claudeSessionExternalSourceAdapter.recognizes(
        `projects/synthetic-project/${SYNTHETIC_SESSION_ID}/subagents/agent-synthetic.jsonl`,
      ),
    ).toBe(true);
    expect(claudeSessionExternalSourceAdapter.recognizes("projects/synthetic-project/history.jsonl")).toBe(false);
    expect(claudeSessionExternalSourceAdapter.recognizes("debug/session.jsonl")).toBe(false);

    expect(claudeMemoryExternalSourceAdapter.recognizes("CLAUDE.md")).toBe(true);
    expect(claudeMemoryExternalSourceAdapter.recognizes("CLAUDE.local.md")).toBe(true);
    expect(claudeMemoryExternalSourceAdapter.recognizes(".claude/rules/team/synthetic.md")).toBe(true);
    expect(claudeMemoryExternalSourceAdapter.recognizes("projects/synthetic-project/memory/MEMORY.md")).toBe(true);
    expect(claudeMemoryExternalSourceAdapter.recognizes("projects/synthetic-project/settings.json")).toBe(false);
    expect(claudeMemoryExternalSourceAdapter.recognizes("arbitrary/repository/file.md")).toBe(false);
  });

  it("normalizes Codex session text deterministically while excluding private runtime bodies", async () => {
    const file = readResult(CODEX_PATH, SYNTHETIC_CODEX_ROLLOUT_JSONL);
    const policy = acceptedPolicy(SYNTHETIC_CODEX_PRODUCER_VERSION);
    const inspection = await codexRolloutExternalSourceAdapter.inspect({ file, policy, signal: liveSignal() });
    expect(inspection).toMatchObject({
      producerVersion: SYNTHETIC_CODEX_PRODUCER_VERSION,
      messageCount: 3,
      lineageNodeCount: 1,
      lineageDepth: 1,
      disposition: "supported",
      reasonCodes: [],
    });
    expect(await codexRolloutExternalSourceAdapter.inspect({ file, policy, signal: liveSignal() })).toEqual(inspection);
    expect(JSON.stringify(inspection)).not.toContain(SYNTHETIC_CODEX_VISIBLE_USER_TEXT);

    const catalogItem = catalog(codexRolloutExternalSourceAdapter, file, inspection);
    const first = await codexRolloutExternalSourceAdapter.normalize({
      catalogItem,
      file,
      policy,
      signal: liveSignal(),
    });
    const second = await codexRolloutExternalSourceAdapter.normalize({
      catalogItem,
      file,
      policy,
      signal: liveSignal(),
    });
    expect(first.normalizedArtifactSha256).toBe(second.normalizedArtifactSha256);
    expect(first.normalizedBytes).toEqual(second.normalizedBytes);
    expect(first.normalizedArtifactSha256).toBe(sha256(first.normalizedBytes));
    const normalized = new TextDecoder().decode(first.normalizedBytes);
    expect(normalized).toContain(SYNTHETIC_CODEX_VISIBLE_USER_TEXT);
    expect(normalized).toContain(SYNTHETIC_CODEX_VISIBLE_ASSISTANT_TEXT);
    expect(normalized).toContain(SYNTHETIC_CODEX_COMPACTION_TEXT);
    for (const sentinel of SYNTHETIC_CODEX_EXCLUDED_SENTINELS) expect(normalized).not.toContain(sentinel);
    expect(normalized).not.toContain("SYNTHETIC_CODEX_REPLACEMENT_HISTORY_EXCLUDED");
    expect(normalized).not.toContain("C:\\\\synthetic");
  });

  it("normalizes the same Codex session bytes identically across active and archive aliases", async () => {
    const policy = acceptedPolicy(SYNTHETIC_CODEX_PRODUCER_VERSION);
    const activeFile = readResult(CODEX_PATH, SYNTHETIC_CODEX_ROLLOUT_JSONL);
    const archivedFile = readResult(CODEX_ARCHIVED_PATH, SYNTHETIC_CODEX_ROLLOUT_JSONL);
    const activeInspection = await codexRolloutExternalSourceAdapter.inspect({
      file: activeFile,
      policy,
      signal: liveSignal(),
    });
    const archivedInspection = await codexRolloutExternalSourceAdapter.inspect({
      file: archivedFile,
      policy,
      signal: liveSignal(),
    });
    expect(archivedInspection).toEqual(activeInspection);

    const active = await codexRolloutExternalSourceAdapter.normalize({
      catalogItem: catalog(codexRolloutExternalSourceAdapter, activeFile, activeInspection),
      file: activeFile,
      policy,
      signal: liveSignal(),
    });
    const archived = await codexRolloutExternalSourceAdapter.normalize({
      catalogItem: catalog(codexRolloutExternalSourceAdapter, archivedFile, archivedInspection),
      file: archivedFile,
      policy,
      signal: liveSignal(),
    });
    expect(archived.normalizedArtifactSha256).toBe(active.normalizedArtifactSha256);
    expect(archived.normalizedBytes).toEqual(active.normalizedBytes);
  });

  it("marks a Codex payload whose session identity disagrees with the rollout filename conflicting", async () => {
    const differentSessionPath = CODEX_PATH.replace(SYNTHETIC_SESSION_ID, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const inspection = await codexRolloutExternalSourceAdapter.inspect({
      file: readResult(differentSessionPath, SYNTHETIC_CODEX_ROLLOUT_JSONL),
      policy: acceptedPolicy(SYNTHETIC_CODEX_PRODUCER_VERSION),
      signal: liveSignal(),
    });
    expect(inspection).toMatchObject({
      disposition: "conflicting",
      reasonCodes: ["conflicting_session_identity"],
    });
  });

  it("normalizes Claude user-visible text and tool metadata without reasoning, tool bodies, or system state", async () => {
    const file = readResult(CLAUDE_PATH, SYNTHETIC_CLAUDE_SESSION_JSONL);
    const policy = acceptedPolicy(SYNTHETIC_CLAUDE_PRODUCER_VERSION);
    const inspection = await claudeSessionExternalSourceAdapter.inspect({ file, policy, signal: liveSignal() });
    expect(inspection).toMatchObject({
      producerVersion: SYNTHETIC_CLAUDE_PRODUCER_VERSION,
      messageCount: 2,
      lineageNodeCount: 4,
      lineageDepth: 4,
      disposition: "supported",
      reasonCodes: [],
    });
    const normalized = await claudeSessionExternalSourceAdapter.normalize({
      catalogItem: catalog(claudeSessionExternalSourceAdapter, file, inspection),
      file,
      policy,
      signal: liveSignal(),
    });
    expect(normalized.normalizedArtifactSha256).toBe(sha256(normalized.normalizedBytes));
    const artifact = new TextDecoder().decode(normalized.normalizedBytes);
    expect(artifact).toContain(SYNTHETIC_CLAUDE_VISIBLE_USER_TEXT);
    expect(artifact).toContain(SYNTHETIC_CLAUDE_VISIBLE_ASSISTANT_TEXT);
    expect(artifact).toContain("SyntheticReadOnlyTool");
    expect(artifact).toContain('"status":"succeeded"');
    for (const sentinel of SYNTHETIC_CLAUDE_EXCLUDED_SENTINELS) expect(artifact).not.toContain(sentinel);
    expect(artifact).not.toContain("synthetic-signature");
    expect(artifact).not.toContain("synthetic-branch");
    expect(artifact).not.toContain("C:\\\\synthetic");
  });

  it("treats Markdown as an explicitly selected opaque item and never follows imports", async () => {
    const cases = [
      {
        adapter: codexMemoryExternalSourceAdapter,
        path: "MEMORY.md",
        text: SYNTHETIC_CODEX_MEMORY_MARKDOWN,
        literalImport: "./synthetic-linked.md",
      },
      {
        adapter: claudeMemoryExternalSourceAdapter,
        path: "projects/synthetic-project/memory/MEMORY.md",
        text: SYNTHETIC_CLAUDE_MEMORY_MARKDOWN,
        literalImport: "@./synthetic-import.md",
      },
    ] as const;
    for (const testCase of cases) {
      const file = readResult(testCase.path, testCase.text);
      const policy = acceptedPolicy(EXTERNAL_SOURCE_UNVERSIONED_MARKDOWN_PRODUCER);
      const inspection = await testCase.adapter.inspect({ file, policy, signal: liveSignal() });
      expect(inspection).toMatchObject({
        producerVersion: EXTERNAL_SOURCE_UNVERSIONED_MARKDOWN_PRODUCER,
        messageCount: 1,
        lineageNodeCount: 1,
        disposition: "supported",
      });
      const normalized = await testCase.adapter.normalize({
        catalogItem: catalog(testCase.adapter, file, inspection),
        file,
        policy,
        signal: liveSignal(),
      });
      const artifact = new TextDecoder().decode(normalized.normalizedBytes);
      expect(artifact).toContain(testCase.literalImport);
      expect(artifact).not.toContain("SYNTHETIC_REFERENCED_FILE_BODY");
    }
  });

  it("fails closed on unaccepted producer versions for all four adapters", async () => {
    const cases = [
      {
        adapter: codexRolloutExternalSourceAdapter,
        file: readResult(CODEX_PATH, SYNTHETIC_CODEX_ROLLOUT_JSONL),
      },
      {
        adapter: claudeSessionExternalSourceAdapter,
        file: readResult(CLAUDE_PATH, SYNTHETIC_CLAUDE_SESSION_JSONL),
      },
      {
        adapter: codexMemoryExternalSourceAdapter,
        file: readResult("MEMORY.md", SYNTHETIC_CODEX_MEMORY_MARKDOWN),
      },
      {
        adapter: claudeMemoryExternalSourceAdapter,
        file: readResult("CLAUDE.md", SYNTHETIC_CLAUDE_MEMORY_MARKDOWN),
      },
    ] as const;
    for (const testCase of cases) {
      const inspection = await testCase.adapter.inspect({
        file: testCase.file,
        policy: acceptedPolicy("different-producer.v9"),
        signal: liveSignal(),
      });
      expect(inspection.disposition).toBe("unsupported_variant");
      expect(inspection.reasonCodes).toEqual(["unsupported_producer_version"]);
    }
  });

  it("quarantines corrupt or truncated JSONL and blocks oversized lines and Markdown", async () => {
    for (const testCase of [
      {
        adapter: codexRolloutExternalSourceAdapter,
        path: CODEX_PATH,
        producer: SYNTHETIC_CODEX_PRODUCER_VERSION,
        text: SYNTHETIC_CODEX_ROLLOUT_JSONL,
      },
      {
        adapter: claudeSessionExternalSourceAdapter,
        path: CLAUDE_PATH,
        producer: SYNTHETIC_CLAUDE_PRODUCER_VERSION,
        text: SYNTHETIC_CLAUDE_SESSION_JSONL,
      },
    ] as const) {
      const corrupt = await testCase.adapter.inspect({
        file: readResult(testCase.path, testCase.text.slice(0, -7)),
        policy: acceptedPolicy(testCase.producer),
        signal: liveSignal(),
      });
      expect(corrupt).toMatchObject({ disposition: "quarantined", reasonCodes: ["corrupt_jsonl"] });

      const oversized = await testCase.adapter.inspect({
        file: readResult(testCase.path, `{"value":"${"x".repeat(EXTERNAL_SOURCE_LIMITS.jsonlLineBytes)}"}\n`),
        policy: acceptedPolicy(testCase.producer),
        signal: liveSignal(),
      });
      expect(oversized).toMatchObject({ disposition: "blocked", reasonCodes: ["jsonl_line_limit"] });
    }

    const oversizedMarkdown = await codexMemoryExternalSourceAdapter.inspect({
      file: readResult("MEMORY.md", "x".repeat(EXTERNAL_SOURCE_LIMITS.markdownItemBytes + 1)),
      policy: acceptedPolicy(EXTERNAL_SOURCE_UNVERSIONED_MARKDOWN_PRODUCER),
      signal: liveSignal(),
    });
    expect(oversizedMarkdown).toMatchObject({ disposition: "blocked", reasonCodes: ["markdown_item_limit"] });
  });

  it("quarantines invalid UTF-8 and blocks reader-evidence drift", async () => {
    const invalidBytes = new Uint8Array([0xc3, 0x28]);
    const invalidUtf8 = await codexRolloutExternalSourceAdapter.inspect({
      file: readBytes(CODEX_PATH, invalidBytes),
      policy: acceptedPolicy(SYNTHETIC_CODEX_PRODUCER_VERSION),
      signal: liveSignal(),
    });
    expect(invalidUtf8).toMatchObject({ disposition: "quarantined", reasonCodes: ["invalid_utf8"] });

    const admitted = readResult(CODEX_PATH, SYNTHETIC_CODEX_ROLLOUT_JSONL);
    const drifted = await codexRolloutExternalSourceAdapter.inspect({
      file: { ...admitted, rawSha256: "0".repeat(64) },
      policy: acceptedPolicy(SYNTHETIC_CODEX_PRODUCER_VERSION),
      signal: liveSignal(),
    });
    expect(drifted).toMatchObject({
      disposition: "blocked",
      reasonCodes: ["source_integrity_mismatch"],
    });
  });

  it("marks unknown envelope, record, block, and field keys unsupported instead of best-effort parsing", async () => {
    const codexUnknownEnvelope = appendJsonl(SYNTHETIC_CODEX_ROLLOUT_JSONL, {
      type: "future_envelope",
      payload: {},
    });
    await expectUnsupported(
      codexRolloutExternalSourceAdapter,
      readResult(CODEX_PATH, codexUnknownEnvelope),
      SYNTHETIC_CODEX_PRODUCER_VERSION,
      "unknown_envelope_type",
    );

    const codexUnknownKey = mutateJsonlLine(SYNTHETIC_CODEX_ROLLOUT_JSONL, 1, (record) => ({
      ...record,
      futureKey: true,
    }));
    await expectUnsupported(
      codexRolloutExternalSourceAdapter,
      readResult(CODEX_PATH, codexUnknownKey),
      SYNTHETIC_CODEX_PRODUCER_VERSION,
      "unknown_field_shape",
    );

    const claudeUnknownRecord = appendJsonl(SYNTHETIC_CLAUDE_SESSION_JSONL, { type: "future-record" });
    await expectUnsupported(
      claudeSessionExternalSourceAdapter,
      readResult(CLAUDE_PATH, claudeUnknownRecord),
      SYNTHETIC_CLAUDE_PRODUCER_VERSION,
      "unknown_record_type",
    );

    const claudeUnknownKey = mutateJsonlLine(SYNTHETIC_CLAUDE_SESSION_JSONL, 0, (record) => ({
      ...record,
      futureKey: true,
    }));
    await expectUnsupported(
      claudeSessionExternalSourceAdapter,
      readResult(CLAUDE_PATH, claudeUnknownKey),
      SYNTHETIC_CLAUDE_PRODUCER_VERSION,
      "unknown_field_shape",
    );

    const claudeUnknownBlock = mutateJsonlLine(SYNTHETIC_CLAUDE_SESSION_JSONL, 0, (record) => ({
      ...record,
      message: { role: "user", content: [{ type: "future_block", value: "excluded" }] },
    }));
    await expectUnsupported(
      claudeSessionExternalSourceAdapter,
      readResult(CLAUDE_PATH, claudeUnknownBlock),
      SYNTHETIC_CLAUDE_PRODUCER_VERSION,
      "unknown_record_type",
    );
  });

  it("quarantines lineage cycles, depth and node overflow, and marks duplicate IDs with different bytes conflicting", async () => {
    const cycle = claudeSystemJsonl([
      claudeSystemRecord("aaaaaaaa-aaaa-4aaa-8aaa-000000000001", "aaaaaaaa-aaaa-4aaa-8aaa-000000000002"),
      claudeSystemRecord("aaaaaaaa-aaaa-4aaa-8aaa-000000000002", "aaaaaaaa-aaaa-4aaa-8aaa-000000000001"),
    ]);
    await expectDisposition(cycle, "quarantined", "lineage_cycle");

    const depthRecords = Array.from({ length: EXTERNAL_SOURCE_LIMITS.lineageDepth + 1 }, (_, index) => {
      const id = syntheticUuid(index + 1);
      return claudeSystemRecord(id, index === 0 ? null : syntheticUuid(index));
    });
    await expectDisposition(claudeSystemJsonl(depthRecords), "quarantined", "lineage_depth_limit");

    const nodeRecords = Array.from({ length: EXTERNAL_SOURCE_LIMITS.lineageNodes + 1 }, (_, index) =>
      claudeSystemRecord(syntheticUuid(index + 1), null),
    );
    await expectDisposition(claudeSystemJsonl(nodeRecords), "quarantined", "lineage_node_limit");

    const duplicateId = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
    const conflicting = claudeSystemJsonl([
      claudeSystemRecord(duplicateId, null, "first"),
      claudeSystemRecord(duplicateId, null, "second"),
    ]);
    await expectDisposition(conflicting, "conflicting", "duplicate_id_conflict");

    const exactDuplicate = claudeSystemRecord(duplicateId, null, "same");
    await expectDisposition(claudeSystemJsonl([exactDuplicate, exactDuplicate]), "supported", undefined);
  });

  it("blocks message and session-count overflow without truncating", async () => {
    const oversizedMessage = mutateJsonlLine(SYNTHETIC_CODEX_ROLLOUT_JSONL, 2, (record) => ({
      ...record,
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "x".repeat(EXTERNAL_SOURCE_LIMITS.normalizedMessageBytes + 1) }],
      },
    }));
    const messageInspection = await codexRolloutExternalSourceAdapter.inspect({
      file: readResult(CODEX_PATH, oversizedMessage),
      policy: acceptedPolicy(SYNTHETIC_CODEX_PRODUCER_VERSION),
      signal: liveSignal(),
    });
    expect(messageInspection).toMatchObject({
      disposition: "blocked",
      reasonCodes: ["normalized_message_limit"],
    });

    const messageRecords = Array.from({ length: EXTERNAL_SOURCE_LIMITS.messagesPerSessionItem + 1 }, (_, index) =>
      claudeUserRecord(syntheticUuid(index + 1)),
    );
    const countInspection = await claudeSessionExternalSourceAdapter.inspect({
      file: readResult(CLAUDE_PATH, toJsonl(messageRecords)),
      policy: acceptedPolicy(SYNTHETIC_CLAUDE_PRODUCER_VERSION),
      signal: liveSignal(),
    });
    expect(countInspection).toMatchObject({ disposition: "blocked", reasonCodes: ["message_count_limit"] });

    const artifactRecords: Record<string, unknown>[] = [
      {
        type: "session_meta",
        payload: { id: SYNTHETIC_SESSION_ID, cli_version: SYNTHETIC_CODEX_PRODUCER_VERSION },
      },
      ...Array.from({ length: 8_500 }, () => ({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "x".repeat(1_024) }],
        },
      })),
    ];
    const artifactInspection = await codexRolloutExternalSourceAdapter.inspect({
      file: readResult(CODEX_PATH, toJsonl(artifactRecords)),
      policy: acceptedPolicy(SYNTHETIC_CODEX_PRODUCER_VERSION),
      signal: liveSignal(),
    });
    expect(artifactInspection).toMatchObject({
      disposition: "blocked",
      reasonCodes: ["normalized_artifact_limit"],
    });
  });

  it("honors cancellation before inspection and normalization", async () => {
    const file = readResult(CODEX_PATH, SYNTHETIC_CODEX_ROLLOUT_JSONL);
    const policy = acceptedPolicy(SYNTHETIC_CODEX_PRODUCER_VERSION);
    const controller = new AbortController();
    controller.abort();
    await expectAdapterError(
      codexRolloutExternalSourceAdapter.inspect({ file, policy, signal: controller.signal }),
      "cancelled",
    );

    const inspection = await codexRolloutExternalSourceAdapter.inspect({ file, policy, signal: liveSignal() });
    await expectAdapterError(
      codexRolloutExternalSourceAdapter.normalize({
        catalogItem: catalog(codexRolloutExternalSourceAdapter, file, inspection),
        file,
        policy,
        signal: controller.signal,
      }),
      "cancelled",
    );
  });

  it("honors cancellation during projection and lineage loops", async () => {
    const records: Record<string, unknown>[] = [
      {
        type: "session_meta",
        payload: { id: SYNTHETIC_SESSION_ID, cli_version: SYNTHETIC_CODEX_PRODUCER_VERSION },
      },
      ...Array.from({ length: 130 }, () => ({
        type: "event_msg",
        payload: { type: "token_count", token_count: {} },
      })),
    ];
    await expectAdapterError(
      codexRolloutExternalSourceAdapter.inspect({
        file: readResult(CODEX_PATH, toJsonl(records)),
        policy: acceptedPolicy(SYNTHETIC_CODEX_PRODUCER_VERSION),
        signal: progressiveAbortSignal(9),
      }),
      "cancelled",
    );

    const nodes = Array.from({ length: 130 }, (_, index) => ({ id: `node-${index.toString().padStart(3, "0")}` }));
    try {
      computeLineage(nodes, progressiveAbortSignal(4));
      throw new Error("Expected lineage cancellation.");
    } catch (error) {
      expect(error).toBeInstanceOf(ExternalSourceAdapterError);
      expect((error as ExternalSourceAdapterError).code).toBe("cancelled");
    }
  });

  it("rejects catalog-to-normalization drift before publishing bytes", async () => {
    const file = readResult(CODEX_PATH, SYNTHETIC_CODEX_ROLLOUT_JSONL);
    const policy = acceptedPolicy(SYNTHETIC_CODEX_PRODUCER_VERSION);
    const inspection = await codexRolloutExternalSourceAdapter.inspect({ file, policy, signal: liveSignal() });
    const staleCatalog = {
      ...catalog(codexRolloutExternalSourceAdapter, file, inspection),
      messageCount: inspection.messageCount + 1,
    };
    await expectAdapterError(
      codexRolloutExternalSourceAdapter.normalize({
        catalogItem: staleCatalog,
        file,
        policy,
        signal: liveSignal(),
      }),
      "catalog_mismatch",
    );

    const changedFile = readResult(
      CODEX_PATH,
      SYNTHETIC_CODEX_ROLLOUT_JSONL.replace(SYNTHETIC_CODEX_VISIBLE_USER_TEXT, "Changed synthetic request."),
    );
    await expectAdapterError(
      codexRolloutExternalSourceAdapter.normalize({
        catalogItem: catalog(codexRolloutExternalSourceAdapter, file, inspection),
        file: changedFile,
        policy,
        signal: liveSignal(),
      }),
      "catalog_mismatch",
    );

    for (const changedEvidence of [
      { ...file, observedMtimeNs: "00000000000000000002" },
      { ...file, filesystemIdentitySha256: sha256("different-filesystem-identity") },
      { ...file, statFingerprintSha256: sha256("different-stat-fingerprint") },
    ]) {
      await expectAdapterError(
        codexRolloutExternalSourceAdapter.normalize({
          catalogItem: catalog(codexRolloutExternalSourceAdapter, file, inspection),
          file: changedEvidence,
          policy,
          signal: liveSignal(),
        }),
        "catalog_mismatch",
      );
    }
  });
});

function acceptedPolicy(version: string): ExternalSourceAdapterPolicyView {
  return {
    unknownVariantDisposition: "block",
    followLinks: false,
    followMarkdownImports: false,
    retainRawBytes: false,
    acceptedProducerVersions: [version],
  };
}

function readResult(relativePath: string, text: string): ExternalSourceReadResult {
  return readBytes(relativePath, new TextEncoder().encode(text));
}

function readBytes(relativePath: string, bytes: Uint8Array): ExternalSourceReadResult {
  return {
    relativePath,
    byteCount: bytes.byteLength,
    observedMtimeNs: "00000000000000000001",
    filesystemIdentitySha256: sha256("synthetic-filesystem-identity"),
    statFingerprintSha256: sha256("synthetic-stat-fingerprint"),
    bytes,
    rawSha256: sha256(bytes),
  };
}

function catalog(
  adapter: ExternalSourceAdapter,
  file: ExternalSourceReadResult,
  inspection: ExternalSourceAdapterInspection,
): ExternalSourceCatalogItem {
  return {
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    workspaceId: "workspace-synthetic",
    sourceId: "source-synthetic",
    scanId: "scan-synthetic",
    itemId: "item-synthetic",
    adapterId: adapter.adapterId,
    adapterVersion: adapter.adapterVersion,
    normalizedRelativePath: file.relativePath,
    aliasRelativePaths: [],
    foreignIdSha256: inspection.foreignIdSha256,
    ...(inspection.producerVersion === undefined ? {} : { producerVersion: inspection.producerVersion }),
    observedMtimeNs: file.observedMtimeNs,
    fileIdentitySha256: file.filesystemIdentitySha256,
    statFingerprintSha256: file.statFingerprintSha256,
    rawSha256: file.rawSha256,
    rawByteCount: file.byteCount,
    messageCount: inspection.messageCount,
    lineageNodeCount: inspection.lineageNodeCount,
    lineageDepth: inspection.lineageDepth,
    lineageSha256: inspection.lineageSha256,
    disposition: inspection.disposition,
    reasonCodes: [...inspection.reasonCodes],
    catalogItemSha256: sha256("synthetic-catalog-item"),
  };
}

async function expectUnsupported(
  adapter: ExternalSourceAdapter,
  file: ExternalSourceReadResult,
  producerVersion: string,
  reasonCode: string,
): Promise<void> {
  const inspection = await adapter.inspect({
    file,
    policy: acceptedPolicy(producerVersion),
    signal: liveSignal(),
  });
  expect(inspection.disposition).toBe("unsupported_variant");
  expect(inspection.reasonCodes).toEqual([reasonCode]);
}

async function expectDisposition(
  text: string,
  disposition: ExternalSourceCatalogItem["disposition"],
  reasonCode: string | undefined,
): Promise<void> {
  const inspection = await claudeSessionExternalSourceAdapter.inspect({
    file: readResult(CLAUDE_PATH, text),
    policy: acceptedPolicy(SYNTHETIC_CLAUDE_PRODUCER_VERSION),
    signal: liveSignal(),
  });
  expect(inspection.disposition).toBe(disposition);
  expect(inspection.reasonCodes).toEqual(reasonCode === undefined ? [] : [reasonCode]);
}

async function expectAdapterError(operation: Promise<unknown>, code: ExternalSourceAdapterErrorCode): Promise<void> {
  try {
    await operation;
    throw new Error(`Expected external source adapter error ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(ExternalSourceAdapterError);
    expect((error as ExternalSourceAdapterError).code).toBe(code);
  }
}

function mutateJsonlLine(
  text: string,
  index: number,
  mutate: (record: Record<string, unknown>) => Record<string, unknown>,
): string {
  const lines = text.trimEnd().split("\n");
  const record = JSON.parse(lines[index] ?? "null") as Record<string, unknown>;
  lines[index] = JSON.stringify(mutate(record));
  return `${lines.join("\n")}\n`;
}

function appendJsonl(text: string, record: Record<string, unknown>): string {
  return `${text.trimEnd()}\n${JSON.stringify(record)}\n`;
}

function claudeSystemJsonl(records: readonly Record<string, unknown>[]): string {
  return toJsonl(records);
}

function claudeSystemRecord(uuid: string, parentUuid: string | null, message = "synthetic"): Record<string, unknown> {
  return {
    type: "system",
    sessionId: SYNTHETIC_SESSION_ID,
    version: SYNTHETIC_CLAUDE_PRODUCER_VERSION,
    uuid,
    parentUuid,
    message,
    timestamp: "2026-07-14T00:20:00.000Z",
  };
}

function claudeUserRecord(uuid: string): Record<string, unknown> {
  return {
    type: "user",
    sessionId: SYNTHETIC_SESSION_ID,
    version: SYNTHETIC_CLAUDE_PRODUCER_VERSION,
    uuid,
    parentUuid: null,
    isSidechain: false,
    message: { role: "user", content: "synthetic" },
    timestamp: "2026-07-14T00:30:00.000Z",
  };
}

function syntheticUuid(index: number): string {
  return `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, "0")}`;
}

function toJsonl(records: readonly Record<string, unknown>[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function liveSignal(): AbortSignal {
  return new AbortController().signal;
}

function progressiveAbortSignal(abortOnRead: number): AbortSignal {
  let reads = 0;
  return {
    get aborted() {
      reads += 1;
      return reads >= abortOnRead;
    },
    addEventListener() {},
  } as unknown as AbortSignal;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
