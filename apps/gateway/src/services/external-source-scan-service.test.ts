import { createHash } from "node:crypto";
import {
  EXTERNAL_SOURCE_LIMITS,
  EXTERNAL_SOURCE_SCHEMA_VERSION,
  type ExternalSourceCatalogItem,
  type ExternalSourceRecord,
  type ExternalSourceScanRecord,
} from "@goatcitadel/contracts";
import { sealExternalSourceRecord } from "@goatcitadel/storage";
import { describe, expect, it } from "vitest";
import {
  SYNTHETIC_CODEX_PRODUCER_VERSION,
  SYNTHETIC_CODEX_ROLLOUT_JSONL,
  SYNTHETIC_CODEX_VISIBLE_USER_TEXT,
  SYNTHETIC_SESSION_ID,
} from "./external-source-adapters/fixtures/synthetic-fixtures.js";
import { EXTERNAL_SOURCE_FIXED_ADAPTER_VERSION } from "./external-source-adapters/internal.js";
import {
  ExternalSourceReaderError,
  type ExternalSourceEnumeratedFile,
  type ExternalSourceEnumeration,
  type ExternalSourceReadResult,
  type ExternalSourceReaderPort,
} from "./external-source-reader.js";
import {
  ExternalSourceScanService,
  ExternalSourceScanServiceError,
  type ExternalSourceConfigReadPort,
  type ExternalSourceScanClock,
  type ExternalSourceScanScheduler,
  type ExternalSourceScanWritePort,
} from "./external-source-scan-service.js";

const ACTIVE_PATH = `sessions/2026/07/14/rollout-2026-07-14T00-00-00-${SYNTHETIC_SESSION_ID}.jsonl`;
const ARCHIVED_PATH = `archived_sessions/rollout-2026-07-14T00-00-00-${SYNTHETIC_SESSION_ID}.jsonl`;
const STARTED_AT_MS = Date.parse("2026-07-14T09:00:00.000Z");

describe("HX-407 external source scan service", () => {
  it("folds identical active/archive bytes into one stable item with explicit alias provenance", async () => {
    const active = readResult(ACTIVE_PATH, SYNTHETIC_CODEX_ROLLOUT_JSONL, 2n);
    const archived = readResult(ARCHIVED_PATH, SYNTHETIC_CODEX_ROLLOUT_JSONL, 1n);
    const ignored = readResult("history.jsonl", "synthetic excluded history", 3n);
    const scans = new RecordingScanRepository();
    const reader = new FakeReader([archived, ignored, active]);
    const service = createService({
      source: activeSource(),
      reader,
      scans,
    });

    const scan = await service.scan({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      expectedConfigRevision: 1,
      signal: liveSignal(),
    });

    expect(scan).toMatchObject({
      scanId: "scan-fixed",
      workspaceId: "workspace-1",
      sourceId: "source-1",
      status: "sealed",
      examinedEntryCount: 3,
      itemCount: 1,
      supportedItemCount: 1,
      quarantinedItemCount: 0,
      blockerCodes: [],
    });
    expect(scans.items).toHaveLength(1);
    expect(scans.items[0]).toMatchObject({
      normalizedRelativePath: ACTIVE_PATH,
      aliasRelativePaths: [ARCHIVED_PATH],
      rawSha256: active.rawSha256,
      foreignIdSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      disposition: "supported",
      reasonCodes: [],
    });
    expect(scans.items[0]?.itemId).toMatch(/^external-item-[a-f0-9]{64}$/u);
    expect(reader.readPaths).toEqual([ACTIVE_PATH, ARCHIVED_PATH]);
    const persisted = JSON.stringify({ scan: scans.scan, items: scans.items });
    expect(persisted).not.toContain(SYNTHETIC_CODEX_VISIBLE_USER_TEXT);
    expect(persisted).not.toContain("synthetic excluded history");
    expect(persisted).not.toContain(activeSource().canonicalRootPath);
  });

  it("retains every same-identity byte variant as conflicting and never chooses a winner by path or mtime", async () => {
    const active = readResult(ACTIVE_PATH, SYNTHETIC_CODEX_ROLLOUT_JSONL, 20n);
    const changedBytes = SYNTHETIC_CODEX_ROLLOUT_JSONL.replace(
      SYNTHETIC_CODEX_VISIBLE_USER_TEXT,
      "SYNTHETIC_CHANGED_VISIBLE_USER_TEXT",
    );
    const archived = readResult(ARCHIVED_PATH, changedBytes, 1n);
    const scans = new RecordingScanRepository();
    const service = createService({ source: activeSource(), reader: new FakeReader([active, archived]), scans });

    const scan = await service.scan({ workspaceId: "workspace-1", sourceId: "source-1", signal: liveSignal() });

    expect(scan).toMatchObject({
      status: "sealed",
      itemCount: 2,
      supportedItemCount: 0,
      quarantinedItemCount: 2,
      blockerCodes: [],
    });
    expect(new Set(scans.items.map((item) => item.rawSha256))).toEqual(new Set([active.rawSha256, archived.rawSha256]));
    expect(scans.items).toHaveLength(2);
    for (const item of scans.items) {
      expect(item.disposition).toBe("conflicting");
      expect(item.reasonCodes).toContain("duplicate_id_conflict");
      expect(item.aliasRelativePaths).toEqual([]);
    }

    const reordered = new RecordingScanRepository();
    await createService({
      source: activeSource(),
      reader: new FakeReader([archived, active]),
      scans: reordered,
    }).scan({ workspaceId: "workspace-1", sourceId: "source-1", signal: liveSignal() });
    expect(reordered.items).toEqual(scans.items);
  });

  it("seals a content-free blocked scan when the single scan deadline expires", async () => {
    const file = readResult(ACTIVE_PATH, SYNTHETIC_CODEX_ROLLOUT_JSONL, 1n);
    const scans = new RecordingScanRepository();
    const scheduler: ExternalSourceScanScheduler = {
      schedule(callback) {
        callback();
        return "deadline";
      },
      cancel() {},
    };
    const service = createService({ source: activeSource(), reader: new FakeReader([file]), scans, scheduler });

    const scan = await service.scan({ workspaceId: "workspace-1", sourceId: "source-1", signal: liveSignal() });

    expect(scan).toMatchObject({
      status: "blocked",
      itemCount: 0,
      blockerCodes: ["scan_timeout"],
      startedAt: "2026-07-14T09:00:00.000Z",
      completedAt: "2026-07-14T09:00:00.000Z",
    });
    expect(scans.items).toEqual([]);
  });

  it("publishes no scan for caller cancellation or an inactive source", async () => {
    const scans = new RecordingScanRepository();
    const reader = new FakeReader([]);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      createService({ source: activeSource(), reader, scans }).scan({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        signal: cancelled.signal,
      }),
    ).rejects.toMatchObject<Partial<ExternalSourceScanServiceError>>({ code: "cancelled" });

    await expect(
      createService({ source: activeSource("disabled"), reader, scans }).scan({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        signal: liveSignal(),
      }),
    ).rejects.toMatchObject<Partial<ExternalSourceScanServiceError>>({ code: "source_not_active" });
    expect(scans.calls).toBe(0);
  });

  it("blocks the entire scan when enumeration evidence changes before the admitted read", async () => {
    const enumerated = readResult(ACTIVE_PATH, SYNTHETIC_CODEX_ROLLOUT_JSONL, 1n);
    const changed = { ...enumerated, observedMtimeNs: "00000000000000000002" };
    const scans = new RecordingScanRepository();
    const service = createService({
      source: activeSource(),
      reader: new BindingDriftReader(enumerated, changed),
      scans,
    });

    const scan = await service.scan({ workspaceId: "workspace-1", sourceId: "source-1", signal: liveSignal() });

    expect(scan).toMatchObject({ status: "blocked", itemCount: 0, blockerCodes: ["source_changed"] });
    expect(scans.items).toEqual([]);
  });

  it("binds stable item identity to adapter, foreign identity, and exact bytes rather than path or mtime", async () => {
    const activeScans = new RecordingScanRepository();
    const archiveScans = new RecordingScanRepository();
    await createService({
      source: activeSource(),
      reader: new FakeReader([readResult(ACTIVE_PATH, SYNTHETIC_CODEX_ROLLOUT_JSONL, 99n)]),
      scans: activeScans,
    }).scan({ workspaceId: "workspace-1", sourceId: "source-1", signal: liveSignal() });
    await createService({
      source: activeSource(),
      reader: new FakeReader([readResult(ARCHIVED_PATH, SYNTHETIC_CODEX_ROLLOUT_JSONL, 1n)]),
      scans: archiveScans,
    }).scan({ workspaceId: "workspace-1", sourceId: "source-1", signal: liveSignal() });

    expect(activeScans.items[0]?.itemId).toBe(archiveScans.items[0]?.itemId);
  });

  it("blocks on exact-byte hash drift even when all enumerated metadata still matches", async () => {
    const file = readResult(ACTIVE_PATH, SYNTHETIC_CODEX_ROLLOUT_JSONL, 1n);
    const scans = new RecordingScanRepository();
    const scan = await createService({
      source: activeSource(),
      reader: new BindingDriftReader(file, { ...file, rawSha256: digest("forged-read-evidence") }),
      scans,
    }).scan({ workspaceId: "workspace-1", sourceId: "source-1", signal: liveSignal() });

    expect(scan).toMatchObject({ status: "blocked", itemCount: 0, blockerCodes: ["source_changed"] });
    expect(scans.items).toEqual([]);
  });

  it("rejects duplicate enumeration paths before reads while retaining the validated examined count", async () => {
    const file = readResult(ACTIVE_PATH, SYNTHETIC_CODEX_ROLLOUT_JSONL, 1n);
    const reader = new DuplicateEnumerationReader(file);
    const scans = new RecordingScanRepository();
    const scan = await createService({ source: activeSource(), reader, scans }).scan({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      signal: liveSignal(),
    });

    expect(scan).toMatchObject({
      status: "blocked",
      examinedEntryCount: 2,
      itemCount: 0,
      blockerCodes: ["source_changed"],
    });
    expect(reader.readPaths).toEqual([]);
    expect(scans.calls).toBe(1);
  });

  it("fails closed when enumeration claims fewer examined entries than supplied evidence", async () => {
    const first = readResult(ACTIVE_PATH, SYNTHETIC_CODEX_ROLLOUT_JSONL, 1n);
    const second = readResult(activePath(1), SYNTHETIC_CODEX_ROLLOUT_JSONL, 2n);
    const reader = new InvalidCountReader([first, second]);
    const scans = new RecordingScanRepository();
    const scan = await createService({ source: activeSource(), reader, scans }).scan({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      signal: liveSignal(),
    });

    expect(scan).toMatchObject({
      status: "blocked",
      examinedEntryCount: 0,
      itemCount: 0,
      blockerCodes: ["limit_exceeded"],
    });
    expect(reader.readPaths).toEqual([]);
  });

  it("rejects sparse enumeration evidence rather than silently skipping holes", async () => {
    const file = readResult(ACTIVE_PATH, SYNTHETIC_CODEX_ROLLOUT_JSONL, 1n);
    const reader = new SparseEnumerationReader(file);
    const scans = new RecordingScanRepository();
    const scan = await createService({ source: activeSource(), reader, scans }).scan({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      signal: liveSignal(),
    });

    expect(scan).toMatchObject({ status: "blocked", itemCount: 0, blockerCodes: ["source_changed"] });
    expect(reader.readPaths).toEqual([]);
  });

  it("never exceeds four concurrent admitted reads", async () => {
    const files = Array.from({ length: 8 }, (_, index) =>
      readResult(activePath(index), SYNTHETIC_CODEX_ROLLOUT_JSONL, BigInt(index + 1)),
    );
    const reader = new ConcurrencyTrackingReader(files);
    const scans = new RecordingScanRepository();
    const scan = await createService({ source: activeSource(), reader, scans }).scan({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      signal: liveSignal(),
    });

    expect(scan.status).toBe("sealed");
    expect(reader.maximumConcurrentReads).toBe(EXTERNAL_SOURCE_LIMITS.concurrentFileReads);
    expect(reader.readPaths).toHaveLength(files.length);
  });

  it("classifies concurrent read failures by canonical candidate order rather than completion timing", async () => {
    const files = [
      readResult(activePath(0), SYNTHETIC_CODEX_ROLLOUT_JSONL, 1n),
      readResult(activePath(1), SYNTHETIC_CODEX_ROLLOUT_JSONL, 2n),
    ];
    const scans = new RecordingScanRepository();
    const scan = await createService({
      source: activeSource(),
      reader: new OutOfOrderFailureReader(files),
      scans,
    }).scan({ workspaceId: "workspace-1", sourceId: "source-1", signal: liveSignal() });

    expect(scan).toMatchObject({ status: "blocked", itemCount: 0, blockerCodes: ["source_changed"] });
  });

  it("accepts exactly 32 aliases and blocks the whole scan at 33 aliases", async () => {
    const atLimit = Array.from({ length: 33 }, (_, index) =>
      readResult(activePath(index), SYNTHETIC_CODEX_ROLLOUT_JSONL, BigInt(index + 1)),
    );
    const accepted = new RecordingScanRepository();
    const acceptedScan = await createService({
      source: activeSource(),
      reader: new FakeReader(atLimit),
      scans: accepted,
    }).scan({ workspaceId: "workspace-1", sourceId: "source-1", signal: liveSignal() });
    expect(acceptedScan).toMatchObject({ status: "sealed", itemCount: 1 });
    expect(accepted.items[0]?.aliasRelativePaths).toHaveLength(32);

    const overLimit = [...atLimit, readResult(activePath(33), SYNTHETIC_CODEX_ROLLOUT_JSONL, 34n)];
    const blocked = new RecordingScanRepository();
    const blockedScan = await createService({
      source: activeSource(),
      reader: new FakeReader(overLimit),
      scans: blocked,
    }).scan({ workspaceId: "workspace-1", sourceId: "source-1", signal: liveSignal() });
    expect(blockedScan).toMatchObject({
      status: "blocked",
      examinedEntryCount: 34,
      itemCount: 0,
      blockerCodes: ["alias_path_limit"],
    });
    expect(blocked.items).toEqual([]);
  });

  it("enforces one whole-scan deadline even when the reader ignores its abort signal", async () => {
    const scheduler = new ManualScheduler();
    const reader = new NeverSettlingReadReader([readResult(ACTIVE_PATH, SYNTHETIC_CODEX_ROLLOUT_JSONL, 1n)]);
    const scans = new RecordingScanRepository();
    const pending = createService({ source: activeSource(), reader, scans, scheduler }).scan({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      signal: liveSignal(),
    });

    expect(scheduler.calls).toBe(1);
    expect(scheduler.delayMs).toBe(EXTERNAL_SOURCE_LIMITS.scanWallTimeMs);
    await reader.started;
    scheduler.fire();
    const scan = await pending;
    expect(scan).toMatchObject({
      status: "blocked",
      examinedEntryCount: 1,
      itemCount: 0,
      blockerCodes: ["scan_timeout"],
    });
    expect(reader.observedSignal?.aborted).toBe(true);
    expect(scans.calls).toBe(1);
    expect(scheduler.cancelCalls).toBe(1);
  });

  it("publishes nothing when caller cancellation races a reader that ignores signals", async () => {
    const scheduler = new ManualScheduler();
    const reader = new NeverSettlingReader();
    const scans = new RecordingScanRepository();
    const caller = new AbortController();
    const pending = createService({ source: activeSource(), reader, scans, scheduler }).scan({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      signal: caller.signal,
    });

    caller.abort();
    await expect(pending).rejects.toMatchObject<Partial<ExternalSourceScanServiceError>>({ code: "cancelled" });
    expect(reader.observedSignal?.aborted).toBe(true);
    expect(scans.calls).toBe(0);
    expect(scheduler.cancelCalls).toBe(1);
  });

  it("rechecks the exact active source binding immediately before publication", async () => {
    const initial = activeSource();
    const revised = reviseSource(initial);
    const configs = new SequenceConfigPort([initial, revised]);
    const scans = new RecordingScanRepository();
    await expect(
      createService({
        source: initial,
        configs,
        reader: new FakeReader([readResult(ACTIVE_PATH, SYNTHETIC_CODEX_ROLLOUT_JSONL, 1n)]),
        scans,
      }).scan({ workspaceId: "workspace-1", sourceId: "source-1", signal: liveSignal() }),
    ).rejects.toMatchObject<Partial<ExternalSourceScanServiceError>>({ code: "source_revision_conflict" });

    expect(configs.calls).toBe(2);
    expect(scans.calls).toBe(0);
  });

  it("binds the caller's expected config revision before any reader work", async () => {
    const scans = new RecordingScanRepository();
    await expect(
      createService({
        source: reviseSource(activeSource()),
        reader: new ExplodingReader(),
        scans,
      }).scan({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        expectedConfigRevision: 1,
        signal: liveSignal(),
      }),
    ).rejects.toMatchObject<Partial<ExternalSourceScanServiceError>>({ code: "source_revision_conflict" });
    expect(scans.calls).toBe(0);
  });

  it("rejects a stored policy that attempts to expand the fixed producer registry before reader work", async () => {
    const source = activeSource();
    const { configSha256: _hash, ...draft } = source;
    const forged = sealExternalSourceRecord({
      ...draft,
      adapterPolicy: {
        ...draft.adapterPolicy,
        acceptedProducerVersions: ["operator-manufactured-trust"],
      },
    });
    const scans = new RecordingScanRepository();

    await expect(
      createService({ source: forged, reader: new ExplodingReader(), scans }).scan({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        signal: liveSignal(),
      }),
    ).rejects.toMatchObject<Partial<ExternalSourceScanServiceError>>({ code: "source_binding_invalid" });
    expect(scans.calls).toBe(0);
  });

  it("does not leak an absolute source path from configuration failures", async () => {
    const source = activeSource();
    const scans = new RecordingScanRepository();
    const pending = createService({
      source,
      configs: {
        get() {
          throw new Error(`configuration failed at ${source.canonicalRootPath}`);
        },
      },
      reader: new FakeReader([]),
      scans,
    }).scan({ workspaceId: "workspace-1", sourceId: "source-1", signal: liveSignal() });

    const error = await pending.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject<Partial<ExternalSourceScanServiceError>>({
      code: "source_binding_invalid",
      message: "External source scan configuration binding is invalid.",
    });
    expect((error as Error).message).not.toContain(source.canonicalRootPath);
    expect(scans.calls).toBe(0);
  });

  it("converts a deadline crossed at the terminal clock read into a content-free timeout", async () => {
    const scans = new RecordingScanRepository();
    const clock = new SequenceClock([
      STARTED_AT_MS,
      STARTED_AT_MS,
      STARTED_AT_MS,
      STARTED_AT_MS,
      STARTED_AT_MS,
      STARTED_AT_MS + EXTERNAL_SOURCE_LIMITS.scanWallTimeMs,
    ]);
    const scan = await createService({
      source: activeSource(),
      reader: new FakeReader([readResult(ACTIVE_PATH, SYNTHETIC_CODEX_ROLLOUT_JSONL, 1n)]),
      scans,
      clock,
    }).scan({ workspaceId: "workspace-1", sourceId: "source-1", signal: liveSignal() });

    expect(scan).toMatchObject({
      status: "blocked",
      itemCount: 0,
      blockerCodes: ["scan_timeout"],
      completedAt: "2026-07-14T09:01:00.000Z",
    });
    expect(scans.items).toEqual([]);
  });

  it("seals exactly once and exposes only a generic error when the repository fails", async () => {
    const scans = new ThrowingScanRepository();
    const pending = createService({ source: activeSource(), reader: new FakeReader([]), scans }).scan({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      signal: liveSignal(),
    });

    await expect(pending).rejects.toMatchObject<Partial<ExternalSourceScanServiceError>>({
      code: "repository_failure",
      message: "External source scan repository sealing failed.",
    });
    expect(scans.calls).toBe(1);
  });

  it("maps a final transactional config rebind race to a content-free revision conflict", async () => {
    const scans = new RevisionConflictScanRepository();
    const pending = createService({ source: activeSource(), reader: new FakeReader([]), scans }).scan({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      signal: liveSignal(),
    });

    const error = await pending.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject<Partial<ExternalSourceScanServiceError>>({
      code: "source_revision_conflict",
      message: "External source revision does not match the scan request.",
    });
    expect((error as Error).message).not.toContain("F:\\private\\operator\\sessions");
    expect(scans.calls).toBe(1);
  });

  it("rejects a repository return that does not exactly match the sealed scan", async () => {
    const scans = new MismatchedScanRepository();
    await expect(
      createService({ source: activeSource(), reader: new FakeReader([]), scans }).scan({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        signal: liveSignal(),
      }),
    ).rejects.toMatchObject<Partial<ExternalSourceScanServiceError>>({ code: "repository_failure" });
    expect(scans.calls).toBe(1);
  });

  it("classifies unexpected reader failures as content-free blockers without leaking messages", async () => {
    const scans = new RecordingScanRepository();
    const scan = await createService({ source: activeSource(), reader: new ExplodingReader(), scans }).scan({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      signal: liveSignal(),
    });

    expect(scan).toMatchObject({ status: "blocked", itemCount: 0, blockerCodes: ["scan_failed"] });
    expect(JSON.stringify({ scan, items: scans.items })).not.toContain(SYNTHETIC_CODEX_VISIBLE_USER_TEXT);
  });

  it("does not trust a mutated dependency error code as a persisted blocker", async () => {
    const scans = new RecordingScanRepository();
    const scan = await createService({ source: activeSource(), reader: new ForgedCodeReader(), scans }).scan({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      signal: liveSignal(),
    });

    expect(scan).toMatchObject({ status: "blocked", itemCount: 0, blockerCodes: ["scan_failed"] });
    expect(JSON.stringify(scan)).not.toContain("leaked_secret");
  });
});

class TestExternalSourceScanService extends ExternalSourceScanService {
  public override scan(input: {
    workspaceId: string;
    sourceId: string;
    expectedConfigRevision?: number;
    signal: AbortSignal;
  }): Promise<ExternalSourceScanRecord> {
    return super.scan({ ...input, expectedConfigRevision: input.expectedConfigRevision ?? 1 });
  }
}

function createService(input: {
  source: ExternalSourceRecord;
  reader: ExternalSourceReaderPort;
  scans: ExternalSourceScanWritePort;
  configs?: ExternalSourceConfigReadPort;
  clock?: ExternalSourceScanClock;
  scheduler?: ExternalSourceScanScheduler;
}): TestExternalSourceScanService {
  return new TestExternalSourceScanService({
    configs: input.configs ?? { get: () => input.source },
    scans: input.scans,
    reader: input.reader,
    clock: input.clock ?? { nowMs: () => STARTED_AT_MS },
    ids: { createScanId: () => "scan-fixed" },
    ...(input.scheduler ? { scheduler: input.scheduler } : {}),
  });
}

class RecordingScanRepository implements ExternalSourceScanWritePort {
  public calls = 0;
  public items: ExternalSourceCatalogItem[] = [];
  public scan: ExternalSourceScanRecord | undefined;

  public seal(scan: ExternalSourceScanRecord, items: readonly ExternalSourceCatalogItem[]): ExternalSourceScanRecord {
    this.calls += 1;
    this.scan = scan;
    this.items = [...items];
    return scan;
  }
}

class RevisionConflictScanRepository implements ExternalSourceScanWritePort {
  public calls = 0;

  public seal(): ExternalSourceScanRecord {
    this.calls += 1;
    throw Object.assign(new Error("late config drift at F:\\private\\operator\\sessions"), {
      code: "STATE_CONFLICT",
      details: { reason: "source_revision_conflict" },
    });
  }
}

class FakeReader implements ExternalSourceReaderPort {
  protected readonly files = new Map<string, ExternalSourceReadResult>();
  public readonly readPaths: string[] = [];

  public constructor(files: readonly ExternalSourceReadResult[]) {
    for (const file of files) this.files.set(file.relativePath, file);
  }

  public async enumerate(): Promise<ExternalSourceEnumeration> {
    return {
      files: [...this.files.values()].map(withoutBytes),
      examinedEntryCount: this.files.size,
    };
  }

  public async readFile(input: { relativePath: string }): Promise<ExternalSourceReadResult> {
    this.readPaths.push(input.relativePath);
    const file = this.files.get(input.relativePath);
    if (!file) throw new Error("Synthetic external source file is missing.");
    return file;
  }

  public async readFiles(input: { relativePaths: readonly string[] }): Promise<readonly ExternalSourceReadResult[]> {
    return Promise.all(input.relativePaths.map((relativePath) => this.readFile({ relativePath })));
  }
}

class BindingDriftReader implements ExternalSourceReaderPort {
  public constructor(
    private readonly enumerated: ExternalSourceReadResult,
    private readonly read: ExternalSourceReadResult,
  ) {}

  public async enumerate(): Promise<ExternalSourceEnumeration> {
    return { files: [withoutBytes(this.enumerated)], examinedEntryCount: 1 };
  }

  public async readFile(): Promise<ExternalSourceReadResult> {
    return this.read;
  }

  public async readFiles(): Promise<readonly ExternalSourceReadResult[]> {
    return [this.read];
  }
}

class DuplicateEnumerationReader extends FakeReader {
  public constructor(private readonly file: ExternalSourceReadResult) {
    super([file]);
  }

  public override async enumerate(): Promise<ExternalSourceEnumeration> {
    const evidence = withoutBytes(this.file);
    return { files: [evidence, { ...evidence }], examinedEntryCount: 2 };
  }
}

class InvalidCountReader extends FakeReader {
  public override async enumerate(): Promise<ExternalSourceEnumeration> {
    const files = [...this.files.values()].map(withoutBytes);
    return { files, examinedEntryCount: files.length - 1 };
  }
}

class SparseEnumerationReader extends FakeReader {
  public constructor(private readonly file: ExternalSourceReadResult) {
    super([file]);
  }

  public override async enumerate(): Promise<ExternalSourceEnumeration> {
    const files = new Array<ExternalSourceEnumeratedFile>(2);
    files[1] = withoutBytes(this.file);
    return { files, examinedEntryCount: 2 };
  }
}

class ConcurrencyTrackingReader extends FakeReader {
  private concurrentReads = 0;
  public maximumConcurrentReads = 0;

  public override async readFile(input: { relativePath: string }): Promise<ExternalSourceReadResult> {
    this.concurrentReads += 1;
    this.maximumConcurrentReads = Math.max(this.maximumConcurrentReads, this.concurrentReads);
    await Promise.resolve();
    try {
      return await super.readFile(input);
    } finally {
      this.concurrentReads -= 1;
    }
  }
}

class OutOfOrderFailureReader extends FakeReader {
  private releaseLowerFailure!: () => void;
  private readonly higherFailureStarted = new Promise<void>((resolve) => {
    this.releaseLowerFailure = resolve;
  });

  public override async readFile(input: { relativePath: string }): Promise<ExternalSourceReadResult> {
    this.readPaths.push(input.relativePath);
    if (input.relativePath === activePath(0)) {
      await this.higherFailureStarted;
      throw new ExternalSourceReaderError("source_changed");
    }
    this.releaseLowerFailure();
    throw new ExternalSourceReaderError("limit_exceeded");
  }
}

class NeverSettlingReader implements ExternalSourceReaderPort {
  public observedSignal: AbortSignal | undefined;

  public enumerate(input: { signal: AbortSignal }): Promise<ExternalSourceEnumeration> {
    this.observedSignal = input.signal;
    return new Promise<ExternalSourceEnumeration>(() => undefined);
  }

  public async readFile(): Promise<ExternalSourceReadResult> {
    throw new Error("Never-settling reader must not read files.");
  }

  public async readFiles(): Promise<readonly ExternalSourceReadResult[]> {
    throw new Error("Never-settling reader must not read files.");
  }
}

class NeverSettlingReadReader extends FakeReader {
  private resolveStarted!: () => void;
  public readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });
  public observedSignal: AbortSignal | undefined;

  public override readFile(input: { relativePath: string; signal: AbortSignal }): Promise<ExternalSourceReadResult> {
    this.readPaths.push(input.relativePath);
    this.observedSignal = input.signal;
    this.resolveStarted();
    return new Promise<ExternalSourceReadResult>(() => undefined);
  }
}

class ExplodingReader implements ExternalSourceReaderPort {
  public async enumerate(): Promise<ExternalSourceEnumeration> {
    throw new Error(`reader leaked ${SYNTHETIC_CODEX_VISIBLE_USER_TEXT}`);
  }

  public async readFile(): Promise<ExternalSourceReadResult> {
    throw new Error("Exploding reader must not read files.");
  }

  public async readFiles(): Promise<readonly ExternalSourceReadResult[]> {
    throw new Error("Exploding reader must not read files.");
  }
}

class ForgedCodeReader extends ExplodingReader {
  public override async enumerate(): Promise<ExternalSourceEnumeration> {
    const error = new ExternalSourceReaderError("source_changed");
    Object.defineProperty(error, "code", { configurable: true, value: "leaked_secret" });
    throw error;
  }
}

class ManualScheduler implements ExternalSourceScanScheduler {
  private callback: (() => void) | undefined;
  public calls = 0;
  public cancelCalls = 0;
  public delayMs: number | undefined;

  public schedule(callback: () => void, delayMs: number): unknown {
    this.calls += 1;
    this.callback = callback;
    this.delayMs = delayMs;
    return "manual-deadline";
  }

  public cancel(): void {
    this.cancelCalls += 1;
  }

  public fire(): void {
    const callback = this.callback;
    if (!callback) throw new Error("Manual scheduler was not armed.");
    callback();
  }
}

class SequenceConfigPort implements ExternalSourceConfigReadPort {
  public calls = 0;

  public constructor(private readonly records: readonly ExternalSourceRecord[]) {}

  public get(): ExternalSourceRecord {
    const record = this.records[Math.min(this.calls, this.records.length - 1)];
    this.calls += 1;
    if (!record) throw new Error("Synthetic source configuration is missing.");
    return record;
  }
}

class SequenceClock implements ExternalSourceScanClock {
  private cursor = 0;

  public constructor(private readonly values: readonly number[]) {}

  public nowMs(): number {
    const value = this.values[Math.min(this.cursor, this.values.length - 1)];
    this.cursor += 1;
    if (value === undefined) throw new Error("Synthetic clock value is missing.");
    return value;
  }
}

class ThrowingScanRepository extends RecordingScanRepository {
  public override seal(): ExternalSourceScanRecord {
    this.calls += 1;
    throw new Error(`repository leaked ${SYNTHETIC_CODEX_VISIBLE_USER_TEXT}`);
  }
}

class MismatchedScanRepository extends RecordingScanRepository {
  public override seal(
    scan: ExternalSourceScanRecord,
    items: readonly ExternalSourceCatalogItem[],
  ): ExternalSourceScanRecord {
    super.seal(scan, items);
    return { ...scan, blockerCodes: ["repository_mutated"] };
  }
}

function activeSource(status: ExternalSourceRecord["status"] = "active"): ExternalSourceRecord {
  return sealExternalSourceRecord({
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    sourceId: "source-1",
    workspaceId: "workspace-1",
    kind: "codex_sessions",
    label: "Synthetic Codex sessions",
    ownerActorId: "operator-1",
    authActorId: "operator-1",
    authActorSource: "token",
    canonicalRootPath: "F:\\synthetic\\codex",
    rootIdentitySha256: digest("root"),
    pathBridgeSnapshotId: "path-snapshot-1",
    pathBridgeSnapshotSha256: digest("path-snapshot"),
    allowedRootsSha256: digest("allowed-roots"),
    inputFlavor: "windows_native",
    targetFlavor: "windows_native",
    requireGitIdentity: false,
    rootGrantApprovalId: "approval-root-1",
    ownershipAttestationSha256: digest("attestation"),
    adapterId: "codex.rollout-jsonl.v1",
    adapterVersion: EXTERNAL_SOURCE_FIXED_ADAPTER_VERSION,
    adapterPolicy: {
      unknownVariantDisposition: "block",
      followLinks: false,
      followMarkdownImports: false,
      retainRawBytes: false,
      acceptedProducerVersions: [SYNTHETIC_CODEX_PRODUCER_VERSION],
    },
    revision: 1,
    status,
    createdAt: "2026-07-14T08:00:00.000Z",
    updatedAt: "2026-07-14T08:00:00.000Z",
  });
}

function reviseSource(source: ExternalSourceRecord): ExternalSourceRecord {
  const { configSha256: _configSha256, ...draft } = source;
  return sealExternalSourceRecord({
    ...draft,
    revision: source.revision + 1,
    updatedAt: "2026-07-14T08:01:00.000Z",
  });
}

function activePath(second: number): string {
  return `sessions/2026/07/14/rollout-2026-07-14T00-00-${second.toString().padStart(2, "0")}-${SYNTHETIC_SESSION_ID}.jsonl`;
}

function readResult(relativePath: string, content: string, mtimeNs: bigint): ExternalSourceReadResult {
  const bytes = new TextEncoder().encode(content);
  return {
    relativePath,
    bytes,
    byteCount: bytes.byteLength,
    observedMtimeNs: mtimeNs.toString().padStart(20, "0"),
    filesystemIdentitySha256: digest(`file:${relativePath}`),
    statFingerprintSha256: digest(`stat:${relativePath}:${mtimeNs.toString()}`),
    rawSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function withoutBytes(file: ExternalSourceReadResult): ExternalSourceEnumeratedFile {
  const { bytes: _bytes, rawSha256: _rawSha256, ...enumerated } = file;
  return enumerated;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function liveSignal(): AbortSignal {
  return new AbortController().signal;
}
