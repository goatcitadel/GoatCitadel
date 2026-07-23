import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  WorkerCellFilesystemError,
  assertWorkerCellPathInJail,
  scanWorkerCellFootprint,
  type WorkerCellFilesystemNode,
  type WorkerCellFilesystemNodeKind,
  type WorkerCellFilesystemProbe,
} from "./remote-worker-cell-filesystem.js";

const ROOT = path.resolve("/cell/root");

interface FakeEntry {
  kind: WorkerCellFilesystemNodeKind;
  physicalBytes?: number;
  deviceId?: number;
  inode?: number;
  hardLinkCount?: number;
  children?: string[];
}

class FakeProbe implements WorkerCellFilesystemProbe {
  public constructor(private readonly tree: Record<string, FakeEntry>) {}

  public probe(absolutePath: string): WorkerCellFilesystemNode {
    const entry = this.tree[path.resolve(absolutePath)];
    if (!entry) throw new Error(`missing fake node: ${absolutePath}`);
    return {
      name: path.basename(absolutePath),
      kind: entry.kind,
      physicalBytes: entry.physicalBytes ?? 0,
      deviceId: entry.deviceId ?? 100,
      inode: entry.inode ?? Math.abs(hash(absolutePath)),
      hardLinkCount: entry.hardLinkCount ?? 1,
    };
  }

  public readdir(absolutePath: string): string[] {
    return this.tree[path.resolve(absolutePath)]?.children ?? [];
  }
}

function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = (h * 31 + value.charCodeAt(i)) | 0;
  return h;
}

describe("HX-505 cell filesystem — path jail", () => {
  it("keeps in-jail paths and rejects traversal, absolute escape, and NUL", () => {
    expect(assertWorkerCellPathInJail("staging/out.bin", ROOT)).toBe(path.join(ROOT, "staging/out.bin"));
    expect(assertWorkerCellPathInJail(ROOT, ROOT)).toBe(ROOT);
    for (const bad of ["../escape", "staging/../../escape", path.resolve("/etc/passwd"), "a\0b"]) {
      expect(() => assertWorkerCellPathInJail(bad, ROOT), bad).toThrow(WorkerCellFilesystemError);
    }
  });
});

describe("HX-505 cell filesystem — no-follow scan fails closed", () => {
  it("counts unique physical bytes across a safe tree", () => {
    const probe = new FakeProbe({
      [ROOT]: { kind: "directory", physicalBytes: 4_096, children: ["a.bin", "sub"] },
      [path.join(ROOT, "a.bin")]: { kind: "file", physicalBytes: 8_192, inode: 1 },
      [path.join(ROOT, "sub")]: { kind: "directory", physicalBytes: 4_096, inode: 2, children: ["b.bin"] },
      [path.join(ROOT, "sub", "b.bin")]: { kind: "file", physicalBytes: 2_048, inode: 3 },
    });
    const result = scanWorkerCellFootprint(ROOT, probe);
    expect(result.uniquePhysicalBytes).toBe(4_096 + 8_192 + 4_096 + 2_048);
    expect(result.fileCount).toBe(2);
    expect(result.directoryCount).toBe(2);
  });

  it("never double-counts a hard-linked inode and rejects a multi-link file", () => {
    const probe = new FakeProbe({
      [ROOT]: { kind: "directory", children: ["hardlinked.bin"] },
      [path.join(ROOT, "hardlinked.bin")]: { kind: "file", physicalBytes: 10_000, inode: 9, hardLinkCount: 2 },
    });
    expect(() => scanWorkerCellFootprint(ROOT, probe)).toThrow(/hard-linked/u);
  });

  it("fails closed on symlink, junction/reparse, ADS, device, socket, and FIFO nodes", () => {
    for (const kind of [
      "symlink",
      "reparse_point",
      "alternate_data_stream",
      "device",
      "socket",
      "fifo",
      "unknown",
    ] as const) {
      const probe = new FakeProbe({
        [ROOT]: { kind: "directory", children: ["evil"] },
        [path.join(ROOT, "evil")]: { kind, physicalBytes: 1 },
      });
      expect(() => scanWorkerCellFootprint(ROOT, probe), kind).toThrow(/fail closed/u);
    }
  });

  it("rejects a mount crossing (a child on a different device)", () => {
    const probe = new FakeProbe({
      [ROOT]: { kind: "directory", deviceId: 100, children: ["mnt"] },
      [path.join(ROOT, "mnt")]: { kind: "directory", deviceId: 200, children: [] },
    });
    expect(() => scanWorkerCellFootprint(ROOT, probe)).toThrow(/mount crossing/u);
  });

  it("rejects an unsafe entry name and a non-directory root", () => {
    const probe = new FakeProbe({
      [ROOT]: { kind: "directory", children: ["../escape"] },
    });
    expect(() => scanWorkerCellFootprint(ROOT, probe)).toThrow(/unsafe entry name/u);

    const fileRoot = new FakeProbe({ [ROOT]: { kind: "file" } });
    expect(() => scanWorkerCellFootprint(ROOT, fileRoot)).toThrow(/not a directory/u);
  });

  it("enforces entry and depth bounds", () => {
    const probe = new FakeProbe({
      [ROOT]: { kind: "directory", children: ["deep"] },
      [path.join(ROOT, "deep")]: { kind: "directory", children: [] },
    });
    expect(() => scanWorkerCellFootprint(ROOT, probe, { maxEntries: 1 })).toThrow(/entry bound/u);
    expect(() => scanWorkerCellFootprint(ROOT, probe, { maxDepth: 1 })).toThrow(/depth bound/u);
  });
});
