import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  EXTERNAL_SOURCE_LIMITS,
  EXTERNAL_SOURCE_SCHEMA_VERSION,
  WORKSPACE_PATH_BRIDGE_SNAPSHOT_VERSION,
  canonicalJsonString,
  type ExternalSourceRecord,
  type WorkspacePathBridgeSnapshotRecord,
} from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import {
  ExternalSourceReader,
  ExternalSourceReaderError,
  NodeExternalSourceReadOnlyFilesystem,
  computeExternalSourceFilesystemIdentity,
  type ExternalSourceCurrentIdentity,
  type ExternalSourceFilesystemStat,
  type ExternalSourceIdentityResolver,
  type ExternalSourceReadOnlyFilesystem,
  type ExternalSourceReadOnlyHandle,
} from "./external-source-reader.js";

describe("ExternalSourceReader", () => {
  it("enumerates deterministically without database sidecars or foreign bytes", async () => {
    const fixture = createFixture();
    fixture.filesystem.addDirectory("nested");
    fixture.filesystem.addFile("zeta.jsonl", bytes("zeta"));
    fixture.filesystem.addFile("nested/alpha.md", bytes("alpha"));
    fixture.filesystem.addFile("state.sqlite", bytes("excluded"));
    fixture.filesystem.addFile("state.sqlite-journal", bytes("excluded"));
    fixture.filesystem.addFile("state.sqlite-wal", bytes("excluded"));
    const result = await fixture.reader.enumerate({ source: fixture.source, signal: freshSignal() });

    expect(result.files.map((entry) => entry.relativePath)).toEqual(["nested/alpha.md", "zeta.jsonl"]);
    expect(result.examinedEntryCount).toBe(6);
    expect(result.files.every((entry) => !("bytes" in entry))).toBe(true);
  });

  it("reads through a read-only handle and returns only bounded bytes plus fingerprints", async () => {
    const fixture = createFixture();
    fixture.filesystem.addFile("session.jsonl", bytes("fixture-session"));
    const result = await fixture.reader.readFile({
      source: fixture.source,
      relativePath: "session.jsonl",
      signal: freshSignal(),
    });

    expect(new TextDecoder().decode(result.bytes)).toBe("fixture-session");
    expect(result.rawSha256).toBe(hashBytes(result.bytes));
    expect(result.observedMtimeNs).toHaveLength(20);
    expect(fixture.filesystem.openCount).toBe(1);
    expect(fixture.filesystem.writeCount).toBe(0);
  });

  it("reserves the exact batch size before opening any file and caps read concurrency at four", async () => {
    const fixture = createFixture();
    const selected = Array.from({ length: 8 }, (_, index) => `item-${index}.jsonl`);
    for (const name of selected) fixture.filesystem.addFile(name, bytes(name));
    fixture.filesystem.readDelayMs = 5;

    const results = await fixture.reader.readFiles({
      source: fixture.source,
      relativePaths: selected,
      signal: freshSignal(),
    });
    expect(results).toHaveLength(8);
    expect(fixture.filesystem.maxConcurrentReads).toBeLessThanOrEqual(EXTERNAL_SOURCE_LIMITS.concurrentFileReads);

    const oversized = createFixture();
    for (let index = 0; index < 2; index += 1) {
      oversized.filesystem.addFile(`large-${index}.jsonl`, new Uint8Array(), {
        size: BigInt(13 * 1024 * 1024),
      });
    }
    await expectCode(
      oversized.reader.readFiles({
        source: oversized.source,
        relativePaths: ["large-0.jsonl", "large-1.jsonl"],
        signal: freshSignal(),
      }),
      "limit_exceeded",
    );
    expect(oversized.filesystem.openCount).toBe(0);
  });

  it("blocks a source file above the fixed per-file cap during enumeration", async () => {
    const fixture = createFixture();
    fixture.filesystem.addFile("oversized.jsonl", new Uint8Array(), {
      size: BigInt(EXTERNAL_SOURCE_LIMITS.sourceFileBytes + 1),
    });
    await expectCode(fixture.reader.enumerate({ source: fixture.source, signal: freshSignal() }), "limit_exceeded");
    expect(fixture.filesystem.openCount).toBe(0);
  });

  it.each(["../escape", "nested/CON.txt", "prn", "Com9.log", "lPt1", "clock$.md", "name:stream", "ＣＯＮ.txt"])(
    "rejects unsafe path component %s before opening a handle",
    async (relativePath) => {
      const fixture = createFixture();
      await expectCode(
        fixture.reader.readFile({ source: fixture.source, relativePath, signal: freshSignal() }),
        relativePath === "../escape" ? "unsafe_path" : "unsafe_path",
      );
      expect(fixture.filesystem.openCount).toBe(0);
    },
  );

  it("rejects symbolic links and Windows reparse points at every ancestor", async () => {
    for (const unsafe of [
      { symbolicLink: true, reparsePoint: false },
      { symbolicLink: false, reparsePoint: true },
    ]) {
      const fixture = createFixture();
      fixture.filesystem.addDirectory("unsafe", unsafe);
      fixture.filesystem.addFile("unsafe/item.jsonl", bytes("never-read"));
      await expectCode(
        fixture.reader.readFile({
          source: fixture.source,
          relativePath: "unsafe/item.jsonl",
          signal: freshSignal(),
        }),
        "unsafe_path",
      );
      expect(fixture.filesystem.openCount).toBe(0);
    }
  });

  it("rejects a canonical-path escape even when lstat does not label the node as a link", async () => {
    const fixture = createFixture();
    fixture.filesystem.addDirectory("redirected");
    fixture.filesystem.addFile("redirected/item.jsonl", bytes("never-read"));
    fixture.filesystem.realpathOverrides.set(
      fixture.filesystem.absolute("redirected"),
      path.resolve("outside-synthetic-root"),
    );

    await expectCode(
      fixture.reader.readFile({
        source: fixture.source,
        relativePath: "redirected/item.jsonl",
        signal: freshSignal(),
      }),
      "unsafe_path",
    );
    expect(fixture.filesystem.openCount).toBe(0);
  });

  it("rejects a safe-directory identity swap between preflight and open", async () => {
    const fixture = createFixture();
    fixture.filesystem.addDirectory("stable");
    fixture.filesystem.addFile("stable/item.jsonl", bytes("never-read"));
    const itemPath = fixture.filesystem.absolute("stable/item.jsonl");
    const ancestorPath = fixture.filesystem.absolute("stable");
    fixture.filesystem.afterLstat = (absolutePath) => {
      if (absolutePath !== itemPath) return;
      const ancestor = requiredNode(fixture.filesystem.nodes, ancestorPath);
      ancestor.stat = {
        ...ancestor.stat,
        inode: ancestor.stat.inode + 10n,
        birthtimeNs: ancestor.stat.birthtimeNs + 10n,
      };
      fixture.filesystem.afterLstat = undefined;
    };

    await expectCode(
      fixture.reader.readFile({
        source: fixture.source,
        relativePath: "stable/item.jsonl",
        signal: freshSignal(),
      }),
      "source_changed",
    );
    expect(fixture.filesystem.openCount).toBe(0);
  });

  it("rejects a real Windows junction through the production filesystem adapter", async () => {
    if (process.platform !== "win32") return;
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gc-external-reader-"));
    try {
      const sourceRoot = path.join(temporaryRoot, "source");
      const targetRoot = path.join(temporaryRoot, "target");
      await fs.mkdir(sourceRoot);
      await fs.mkdir(targetRoot);
      await fs.writeFile(path.join(targetRoot, "item.jsonl"), bytes("junction-fixture"));
      await fs.symlink(targetRoot, path.join(sourceRoot, "junction"), "junction");

      const filesystem = new NodeExternalSourceReadOnlyFilesystem();
      const rootStat = await filesystem.lstat(sourceRoot, freshSignal());
      const binding = createBinding(sourceRoot, rootStat);
      const reader = new ExternalSourceReader({
        filesystem,
        identityResolver: new MutableIdentityResolver(binding),
      });
      await expectCode(
        reader.readFile({
          source: binding.source,
          relativePath: "junction/item.jsonl",
          signal: freshSignal(),
        }),
        "unsafe_path",
      );
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("fails closed on a non-link reparse attribute reported by the Windows security port", async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gc-external-reader-reparse-"));
    try {
      const sourceRoot = path.join(temporaryRoot, "source");
      const filePath = path.join(sourceRoot, "placeholder.jsonl");
      await fs.mkdir(sourceRoot);
      await fs.writeFile(filePath, bytes("cloud-placeholder-fixture"));
      const filesystem = new NodeExternalSourceReadOnlyFilesystem({
        windowsSecurity: {
          inspectReparsePoint: async (absolutePath) => absolutePath === filePath,
          applyOwnerOnlyAcl: async () => ({ ownerSid: "S-1-5-18" }),
        },
      });
      const rootStat = await filesystem.lstat(sourceRoot, freshSignal());
      const binding = createBinding(sourceRoot, rootStat);
      const reader = new ExternalSourceReader({
        filesystem,
        identityResolver: new MutableIdentityResolver(binding),
      });

      await expectCode(
        reader.readFile({
          source: binding.source,
          relativePath: "placeholder.jsonl",
          signal: freshSignal(),
        }),
        "unsafe_path",
      );
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("detects append and replacement races and discards the read", async () => {
    for (const mutation of ["append", "replace"] as const) {
      const fixture = createFixture();
      fixture.filesystem.addFile("moving.jsonl", bytes("before"));
      fixture.filesystem.afterFirstRead = (absolutePath, opened) => {
        if (mutation === "append") {
          opened.content = bytes("before-after");
          opened.stat = { ...opened.stat, size: 12n, mtimeNs: opened.stat.mtimeNs + 1n };
        } else {
          fixture.filesystem.replaceFile(absolutePath, bytes("after"));
        }
      };

      await expectCode(
        fixture.reader.readFile({
          source: fixture.source,
          relativePath: "moving.jsonl",
          signal: freshSignal(),
        }),
        "source_changed",
      );
    }
  });

  it("fails closed on directory identity cycles", async () => {
    const fixture = createFixture();
    fixture.filesystem.addDirectory("loop", {}, fixture.filesystem.rootStat);
    await expectCode(fixture.reader.enumerate({ source: fixture.source, signal: freshSignal() }), "cycle_detected");
  });

  it("rechecks the exact HX-406 config, root, flavor, distro, Git, and snapshot binding", async () => {
    const fixture = createFixture();
    fixture.filesystem.addFile("item.md", bytes("item"));
    const changed = sealSource({ ...fixture.source, revision: 2, updatedAt: "2026-07-14T01:00:00.000Z" });
    let resolution = 0;
    fixture.identityResolver.resolveCurrent = async () => {
      resolution += 1;
      return { source: resolution === 1 ? fixture.source : changed, snapshot: fixture.snapshot };
    };
    await expectCode(
      fixture.reader.readFile({ source: fixture.source, relativePath: "item.md", signal: freshSignal() }),
      "identity_drift",
    );

    const wrongRoot = createFixture();
    wrongRoot.source = sealSource({ ...wrongRoot.source, rootIdentitySha256: hashText("wrong-root") });
    wrongRoot.identityResolver.current = { source: wrongRoot.source, snapshot: wrongRoot.snapshot };
    await expectCode(
      wrongRoot.reader.readFile({
        source: wrongRoot.source,
        relativePath: "missing.md",
        signal: freshSignal(),
      }),
      "identity_drift",
    );
  });

  it("requires a live AbortSignal and returns a content-free cancellation", async () => {
    const fixture = createFixture();
    const controller = new AbortController();
    controller.abort();
    await expectCode(fixture.reader.enumerate({ source: fixture.source, signal: controller.signal }), "cancelled");
  });

  it("closes the read-only handle when cancellation arrives during a multi-chunk read", async () => {
    const fixture = createFixture();
    const controller = new AbortController();
    fixture.filesystem.addFile("large.jsonl", new Uint8Array(128 * 1024));
    fixture.filesystem.afterFirstRead = () => controller.abort();

    await expectCode(
      fixture.reader.readFile({
        source: fixture.source,
        relativePath: "large.jsonl",
        signal: controller.signal,
      }),
      "cancelled",
    );
    expect(fixture.filesystem.closeCount).toBe(1);
  });

  it("rejects mtimes that cannot be represented by the exact 20-digit contract field", async () => {
    const fixture = createFixture();
    fixture.filesystem.addFile("future.jsonl", bytes("item"), { mtimeNs: 100_000_000_000_000_000_000n });
    await expectCode(
      fixture.reader.readFile({
        source: fixture.source,
        relativePath: "future.jsonl",
        signal: freshSignal(),
      }),
      "limit_exceeded",
    );
  });
});

interface FakeNode {
  stat: ExternalSourceFilesystemStat;
  content?: Uint8Array;
  names?: Set<string>;
}

class FakeReadOnlyFilesystem implements ExternalSourceReadOnlyFilesystem {
  public readonly rootPath: string;
  public readonly nodes = new Map<string, FakeNode>();
  public openCount = 0;
  public closeCount = 0;
  public writeCount = 0;
  public activeReads = 0;
  public maxConcurrentReads = 0;
  public readDelayMs = 0;
  public afterFirstRead?: (absolutePath: string, opened: FakeNode) => void;
  public afterLstat?: (absolutePath: string) => void;
  public readonly realpathOverrides = new Map<string, string>();
  private nextInode = 2n;
  private mutationApplied = false;

  public constructor(rootPath: string) {
    this.rootPath = rootPath;
    this.nodes.set(rootPath, { stat: stat("directory", 1n), names: new Set() });
  }

  public get rootStat(): ExternalSourceFilesystemStat {
    return { ...requiredNode(this.nodes, this.rootPath).stat };
  }

  public addDirectory(
    relativePath: string,
    overrides: Partial<ExternalSourceFilesystemStat> = {},
    identitySource?: ExternalSourceFilesystemStat,
  ): void {
    const absolutePath = this.absolute(relativePath);
    this.addToParent(relativePath);
    const base = identitySource
      ? { ...identitySource, kind: "directory" as const }
      : stat("directory", this.nextInode++);
    this.nodes.set(absolutePath, { stat: { ...base, ...overrides }, names: new Set() });
  }

  public addFile(
    relativePath: string,
    content: Uint8Array,
    overrides: Partial<ExternalSourceFilesystemStat> = {},
  ): void {
    const absolutePath = this.absolute(relativePath);
    this.addToParent(relativePath);
    this.nodes.set(absolutePath, {
      stat: { ...stat("file", this.nextInode++, BigInt(content.byteLength)), ...overrides },
      content,
    });
  }

  public replaceFile(absolutePath: string, content: Uint8Array): void {
    this.nodes.set(absolutePath, {
      stat: stat("file", this.nextInode++, BigInt(content.byteLength)),
      content,
    });
  }

  public async lstat(absolutePath: string, signal: AbortSignal): Promise<ExternalSourceFilesystemStat> {
    assertLive(signal);
    const stat = { ...requiredNode(this.nodes, absolutePath).stat };
    this.afterLstat?.(absolutePath);
    return stat;
  }

  public async realpath(absolutePath: string, signal: AbortSignal): Promise<string> {
    assertLive(signal);
    requiredNode(this.nodes, absolutePath);
    return this.realpathOverrides.get(absolutePath) ?? absolutePath;
  }

  public async readDirectory(absolutePath: string, signal: AbortSignal): Promise<readonly string[]> {
    assertLive(signal);
    return [...(requiredNode(this.nodes, absolutePath).names ?? [])];
  }

  public async openReadOnly(absolutePath: string, signal: AbortSignal): Promise<ExternalSourceReadOnlyHandle> {
    assertLive(signal);
    this.openCount += 1;
    const opened = requiredNode(this.nodes, absolutePath);
    return {
      stat: async (readSignal) => {
        assertLive(readSignal);
        return { ...opened.stat };
      },
      read: async (buffer, offset, length, position, readSignal) => {
        assertLive(readSignal);
        this.activeReads += 1;
        this.maxConcurrentReads = Math.max(this.maxConcurrentReads, this.activeReads);
        try {
          if (this.readDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.readDelayMs));
          const content = opened.content ?? new Uint8Array();
          const bytesRead = Math.min(length, Math.max(0, content.byteLength - position));
          buffer.set(content.subarray(position, position + bytesRead), offset);
          if (!this.mutationApplied && this.afterFirstRead) {
            this.mutationApplied = true;
            this.afterFirstRead(absolutePath, opened);
          }
          return bytesRead;
        } finally {
          this.activeReads -= 1;
        }
      },
      close: async () => {
        this.closeCount += 1;
      },
    };
  }

  public absolute(relativePath: string): string {
    return path.resolve(this.rootPath, ...relativePath.split("/"));
  }

  private addToParent(relativePath: string): void {
    const segments = relativePath.split("/");
    const name = segments.pop();
    const parent = segments.length === 0 ? this.rootPath : this.absolute(segments.join("/"));
    const parentNode = requiredNode(this.nodes, parent);
    if (!parentNode.names || name === undefined) throw new Error("Synthetic parent is not a directory.");
    parentNode.names.add(name);
  }
}

class MutableIdentityResolver implements ExternalSourceIdentityResolver {
  public constructor(public current: ExternalSourceCurrentIdentity) {}

  public async resolveCurrent(): Promise<ExternalSourceCurrentIdentity | undefined> {
    return this.current;
  }
}

function createFixture(): {
  filesystem: FakeReadOnlyFilesystem;
  identityResolver: MutableIdentityResolver;
  reader: ExternalSourceReader;
  source: ExternalSourceRecord;
  snapshot: WorkspacePathBridgeSnapshotRecord;
} {
  const rootPath = path.resolve("synthetic-external-source-root");
  const filesystem = new FakeReadOnlyFilesystem(rootPath);
  const binding = createBinding(rootPath, filesystem.rootStat);
  const { source, snapshot } = binding;
  const identityResolver = new MutableIdentityResolver(binding);
  const reader = new ExternalSourceReader({ identityResolver, filesystem });
  return { filesystem, identityResolver, reader, source, snapshot };
}

function createBinding(rootPath: string, rootStat: ExternalSourceFilesystemStat): ExternalSourceCurrentIdentity {
  const snapshot = sealSnapshot({
    schemaVersion: WORKSPACE_PATH_BRIDGE_SNAPSHOT_VERSION,
    snapshotId: "snapshot-1",
    requestHash: hashText("request"),
    workspaceId: "workspace-1",
    inputFlavor: "windows_native",
    targetFlavor: "windows_native",
    gitIdentityRequired: false,
    inputPathHash: hashText("input"),
    allowedRootsHash: hashText("roots"),
    canonicalHostPath: rootPath,
    canonicalTargetPath: rootPath,
    roundTrip: {
      attempted: true,
      converter: "native",
      inputHostPathSha256: hashText("host"),
      targetPathSha256: hashText("target"),
      roundTripHostPathSha256: hashText("host"),
      equal: true,
    },
    gitIdentity: { status: "not_repository" },
    status: "verified",
    callable: true,
    createdAt: "2026-07-14T00:00:00.000Z",
  });
  const source = sealSource({
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    sourceId: "source-1",
    workspaceId: "workspace-1",
    kind: "codex_sessions",
    label: "Synthetic source",
    ownerActorId: "actor-1",
    authActorId: "actor-1",
    authActorSource: "none",
    canonicalRootPath: rootPath,
    rootIdentitySha256: computeExternalSourceFilesystemIdentity(rootStat),
    pathBridgeSnapshotId: snapshot.snapshotId,
    pathBridgeSnapshotSha256: snapshot.snapshotSha256,
    allowedRootsSha256: snapshot.allowedRootsHash,
    inputFlavor: snapshot.inputFlavor,
    targetFlavor: snapshot.targetFlavor,
    requireGitIdentity: false,
    ownershipAttestationSha256: hashText("ownership"),
    adapterId: "codex.rollout-jsonl.v1",
    adapterVersion: "1.0.0",
    adapterPolicy: {
      unknownVariantDisposition: "block",
      followLinks: false,
      followMarkdownImports: false,
      retainRawBytes: false,
      acceptedProducerVersions: ["synthetic-v1"],
    },
    revision: 1,
    status: "active",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  });
  return { source, snapshot };
}

function stat(kind: ExternalSourceFilesystemStat["kind"], inode: bigint, size = 0n): ExternalSourceFilesystemStat {
  return {
    kind,
    symbolicLink: false,
    reparsePoint: false,
    device: 10n,
    inode,
    size,
    mtimeNs: 1_750_000_000_000_000_000n,
    birthtimeNs: 1_740_000_000_000_000_000n + inode,
    mode: kind === "directory" ? 16_832n : 33_152n,
  };
}

function sealSource(input: Omit<ExternalSourceRecord, "configSha256"> | ExternalSourceRecord): ExternalSourceRecord {
  const { configSha256: _ignored, ...draft } = input as ExternalSourceRecord;
  return { ...draft, configSha256: hashCanonical(draft) };
}

function sealSnapshot(
  input: Omit<WorkspacePathBridgeSnapshotRecord, "snapshotSha256">,
): WorkspacePathBridgeSnapshotRecord {
  return { ...input, snapshotSha256: hashCanonical(input) };
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value), "utf8").digest("hex");
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

function requiredNode(nodes: ReadonlyMap<string, FakeNode>, absolutePath: string): FakeNode {
  const node = nodes.get(absolutePath);
  if (!node) throw Object.assign(new Error("missing synthetic node"), { code: "ENOENT" });
  return node;
}

function assertLive(signal: AbortSignal): void {
  if (signal.aborted) throw Object.assign(new Error("cancelled"), { code: "ABORT_ERR" });
}

async function expectCode(promise: Promise<unknown>, code: ExternalSourceReaderError["code"]): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected external source reader error ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(ExternalSourceReaderError);
    expect((error as ExternalSourceReaderError).code).toBe(code);
    expect((error as Error).message).not.toMatch(/synthetic-external-source-root|fixture-session|never-read/u);
  }
}
