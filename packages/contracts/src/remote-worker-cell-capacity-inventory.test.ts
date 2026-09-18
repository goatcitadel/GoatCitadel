import { describe, expect, it } from "vitest";
import {
  REMOTE_WORKER_CELL_CAPACITY_FOOTPRINT_CATEGORIES as categories,
  REMOTE_WORKER_CELL_MAX_DISK_BYTES,
} from "./remote-worker-cell.js";
import {
  REMOTE_WORKER_CELL_CAPACITY_INVENTORY_SCHEMA_VERSION as schemaVersion,
  accountRemoteWorkerCellCapacityInventory as account,
  normalizeRemoteWorkerCellCapacityInventory as normalize,
  remoteWorkerCellCapacityInventorySha256 as inventoryHash,
  type RemoteWorkerCellCapacityInventory,
  type RemoteWorkerCellCapacityInventoryObject,
} from "./remote-worker-cell-capacity-inventory.js";

const digest = (value: number) => value.toString(16).padStart(64, "0");
function fixture() {
  const areas = categories.map(category => ({ category, evidenceSha256: digest(100 + categories.indexOf(category)), objects: [] as RemoteWorkerCellCapacityInventoryObject[] }));
  areas[0]!.objects.push({ identitySha256: digest(1), kind: "volume_backing", logicalBytes: 65_536, allocatedBytes: 69_632, backingIdentitySha256: null });
  areas[0]!.objects.push({ identitySha256: digest(2), kind: "file", logicalBytes: 9_000, allocatedBytes: 4_096, backingIdentitySha256: digest(1) });
  areas[0]!.objects.push({ identitySha256: digest(3), kind: "directory", logicalBytes: 0, allocatedBytes: 512, backingIdentitySha256: digest(1) });
  areas.find(area => area.category === "manifestBytes")!.objects.push({ identitySha256: digest(4), kind: "file", logicalBytes: 500, allocatedBytes: 4_096, backingIdentitySha256: null });
  areas.find(area => area.category === "immutableArtifactBytes")!.objects.push({ identitySha256: digest(5), kind: "file", logicalBytes: 10_000, allocatedBytes: 12_288, backingIdentitySha256: null });
  return { schemaVersion, profileSha256: digest(200), captureSha256: digest(201), areas,
    references: [
      { referenceSha256: digest(300), objectIdentitySha256: digest(2) },
      { referenceSha256: digest(301), objectIdentitySha256: digest(5) },
      { referenceSha256: digest(302), objectIdentitySha256: digest(5) },
    ] };
}
const binding = (inventory: RemoteWorkerCellCapacityInventory) => ({ profileSha256: inventory.profileSha256,
  captureSha256: inventory.captureSha256, inventorySha256: inventoryHash(inventory) });

describe("complete declared cell capacity inventory", () => {
  it("charges host identities once, keeps guest allocation separate and charges each logical CAS reference", () => {
    const input = fixture(), result = account(input, binding(input));
    expect(result.footprint.mutableRootBytes).toBe(69_632);
    expect(result.footprint.manifestBytes).toBe(4_096);
    expect(result.footprint.immutableArtifactBytes).toBe(12_288);
    expect(result.hostAllocatedBytes).toBe(86_016);
    expect(result.guestAllocatedBytes).toBe(4_608);
    expect(result.logicalReferenceBytes).toBe(29_000);
    expect(result.logicalReferenceCount).toBe(3);
    expect(result.hostFileCount).toBe(3);
    expect(result.guestFileCount).toBe(1);
    expect(result.guestDirectoryCount).toBe(1);
    expect(result.hostDirectoryCount).toBe(0);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.footprint)).toBe(true);
  });

  it("requires independent profile, capture and complete-inventory bindings", () => {
    const input = fixture(), expected = binding(input);
    for (const field of ["profileSha256", "captureSha256", "inventorySha256"] as const) {
      expect(() => account(input, { ...expected, [field]: digest(999) })).toThrow(/binding/u);
    }
    input.areas[0]!.objects[0] = { ...input.areas[0]!.objects[0]!, allocatedBytes: 4_096 };
    expect(() => account(input, expected)).toThrow(/binding/u);
  });

  it.each(categories)("refuses missing %s coverage instead of supplying zero", category => {
    const input = fixture();
    input.areas = input.areas.filter(area => area.category !== category);
    expect(() => normalize(input)).toThrow(/every footprint area/u);
  });

  it("requires retained evidence for empty coverage and refuses duplicate or unknown areas", () => {
    const input = fixture();
    input.areas[1]!.evidenceSha256 = "";
    expect(() => normalize(input)).toThrow(/SHA-256/u);
    input.areas[1] = input.areas[0]!;
    expect(() => normalize(input)).toThrow(/duplicated/u);
    expect(() => normalize({ ...fixture(), areas: [...fixture().areas.slice(1), { category: "other", evidenceSha256: digest(999), objects: [] }] })).toThrow(/unsupported/u);
  });

  it("refuses duplicated physical identities within or across categories", () => {
    for (const destination of [0, 1]) {
      const input = fixture();
      input.areas[destination]!.objects.push(input.areas[0]!.objects[0]!);
      expect(() => normalize(input)).toThrow(/physical object identity/u);
    }
  });

  it("requires guest objects to identify an included host volume backing", () => {
    for (const target of [digest(99), digest(2), digest(3), digest(4)]) {
      const input = fixture();
      input.areas[0]!.objects[1] = { ...input.areas[0]!.objects[1]!, backingIdentitySha256: target };
      expect(() => normalize(input)).toThrow(/host backing/u);
    }
    const input = fixture();
    input.areas[0]!.objects[0] = { ...input.areas[0]!.objects[0]!, backingIdentitySha256: digest(1) };
    expect(() => normalize(input)).toThrow(/host volume backing/u);
  });

  it("refuses duplicate, dangling, directory and backing logical references", () => {
    const duplicated = fixture();
    duplicated.references.push(duplicated.references[0]!);
    expect(() => normalize(duplicated)).toThrow(/logical reference/u);
    for (const target of [digest(99), digest(3), digest(1)]) {
      const input = fixture();
      input.references[0]!.objectIdentitySha256 = target;
      expect(() => normalize(input)).toThrow(/logical reference/u);
    }
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("refuses invalid byte count %s", value => {
    for (const key of ["logicalBytes", "allocatedBytes"] as const) {
      const input = fixture();
      input.areas[0]!.objects[1] = { ...input.areas[0]!.objects[1]!, [key]: value };
      expect(() => normalize(input)).toThrow(/byte count/u);
    }
  });

  it("refuses logical directory bytes and empty virtual backings", () => {
    const input = fixture();
    input.areas[0]!.objects[2] = { ...input.areas[0]!.objects[2]!, logicalBytes: 1 };
    expect(() => normalize(input)).toThrow(/directories/u);
    input.areas[0]!.objects[2] = fixture().areas[0]!.objects[2]!;
    input.areas[0]!.objects[0] = { ...input.areas[0]!.objects[0]!, logicalBytes: 0 };
    expect(() => normalize(input)).toThrow(/nonempty/u);
  });

  it("retains directory allocations, sparse logical sizes and zero allocation independently", () => {
    const input = fixture();
    input.areas[0]!.objects[1] = { ...input.areas[0]!.objects[1]!, allocatedBytes: 0 };
    input.areas[1]!.objects.push({ identitySha256: digest(6), kind: "directory", logicalBytes: 0, allocatedBytes: 4_096, backingIdentitySha256: null });
    const result = account(input, binding(input));
    expect(result.hostAllocatedBytes).toBe(90_112);
    expect(result.hostDirectoryCount).toBe(1);
    expect(result.guestAllocatedBytes).toBe(512);
    expect(result.logicalReferenceBytes).toBe(29_000);
  });

  it("rejects unsafe aggregate logical references and per-category allocation", () => {
    const input = fixture();
    input.areas[0]!.objects[1] = { ...input.areas[0]!.objects[1]!, logicalBytes: REMOTE_WORKER_CELL_MAX_DISK_BYTES };
    input.references = Array.from({ length: 20_000 }, (_, index) => ({ referenceSha256: digest(1_000 + index), objectIdentitySha256: digest(2) }));
    expect(() => account(input, binding(input))).toThrow(/safe integer/u);
    const physical = fixture();
    physical.areas[1]!.objects.push(...[10, 11].map(id => ({ identitySha256: digest(id), kind: "file" as const, logicalBytes: 0,
      allocatedBytes: REMOTE_WORKER_CELL_MAX_DISK_BYTES, backingIdentitySha256: null })));
    expect(() => account(physical, binding(physical))).toThrow(/inputStagingBytes/u);
  });

  it("bounds the aggregate inventory and reference graph", () => {
    const input = fixture();
    input.areas[1]!.objects = Array.from({ length: 20_000 }, (_, index) => ({ identitySha256: digest(index + 1_000), kind: "file" as const,
      logicalBytes: 0, allocatedBytes: 0, backingIdentitySha256: null }));
    expect(() => normalize(input)).toThrow(/bound/u);
    expect(() => normalize({ ...fixture(), references: Array.from({ length: 20_001 }, () => fixture().references[0]) })).toThrow(/bound/u);
  });

  it("rejects unexpected secret-bearing fields, accessors and sparse arrays without reading getters", () => {
    expect(() => normalize({ ...fixture(), secret: "should-not-be-read" })).toThrow(/unexpected/u);
    const input = fixture();
    let reads = 0;
    Object.defineProperty(input.areas[0]!.objects[0]!, "allocatedBytes", { enumerable: true, get: () => { reads++; return 1; } });
    expect(() => normalize(input)).toThrow(/accessor/u);
    expect(reads).toBe(0);
    const sparse = fixture();
    delete (sparse.references as (unknown | undefined)[])[1];
    expect(() => normalize(sparse)).toThrow(/sparse|hole/u);
  });

  it("normalizes ordering and freezes a private copy of nested capture input", () => {
    const input = fixture(), expected = binding(input), frozen = normalize(input);
    input.areas.reverse();
    for (const area of input.areas) area.objects.reverse();
    input.references.reverse();
    expect(inventoryHash(input)).toBe(expected.inventorySha256);
    input.areas[0]!.evidenceSha256 = digest(999);
    expect(inventoryHash(frozen)).toBe(expected.inventorySha256);
    expect(Object.isFrozen(frozen.areas)).toBe(true);
    expect(frozen.areas.every(area => Object.isFrozen(area) && Object.isFrozen(area.objects) && area.objects.every(Object.isFrozen))).toBe(true);
    expect(Object.isFrozen(frozen.references)).toBe(true);
    expect(frozen.references.every(Object.isFrozen)).toBe(true);
  });
});
