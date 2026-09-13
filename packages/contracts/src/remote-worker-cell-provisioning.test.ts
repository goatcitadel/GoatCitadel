import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { volumeExchangeFixture } from "./remote-worker-cell-volume-test-fixture.js";
import { formatExchangeFixture } from "./remote-worker-cell-format-test-fixture.js";
import { protectionExchangeFixture } from "./remote-worker-cell-protection-test-fixture.js";
import { mountExchangeFixture } from "./remote-worker-cell-mount-test-fixture.js";
import { mountedWorkspaceExchangeFixture } from "./remote-worker-cell-mounted-workspace-test-fixture.js";
import { normalizeRemoteWorkerCellMountedWorkspaceAnchor, readRemoteWorkerCellMountedWorkspaceCheckpoint,
  assertRemoteWorkerCellMountedWorkspaceSuccessor } from "./remote-worker-cell-mounted-workspace.js";
import { rehashVolumeFixture } from "./remote-worker-cell-volume-test-fixture.js";
import {
  assertRemoteWorkerCellProvisioningSuccessor, normalizeRemoteWorkerCellProvisioningPlan,
  readRemoteWorkerCellProvisioningCheckpoint, remoteWorkerCellProvisioningBindingSha256,
  REMOTE_WORKER_CELL_PROVISIONING_PLAN_SCHEMA_VERSION,
  REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION,
  normalizeRemoteWorkerCellProvisioningSubmission, normalizeRemoteWorkerCellProvisioningExchange,
  remoteWorkerCellProvisioningPlanSha256,
  deriveRemoteWorkerCellVolumeAnchor, remoteWorkerCellProvisioningVolumeAnchor,
  remoteWorkerCellProvisioningMountedWorkspaceAnchor,
  REMOTE_WORKER_CELL_PREPARATION_SCHEMA_VERSION, normalizeRemoteWorkerCellPreparation, normalizeRemoteWorkerCellPreparationSubmission,
  type RemoteWorkerCellProvisioningCheckpoint,
} from "./remote-worker-cell-provisioning.js";

const file = (value: number) => "0100000000000000" + value.toString(16).padStart(32, "0");
const plan = {
  schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_PLAN_SCHEMA_VERSION,
  assignmentBindingSha256: "1".repeat(64), profileSha256: "2".repeat(64), parentIdentityHex: file(1),
  cellName: `gc-cell-${"1".repeat(32)}`, ownerSid: "S-1-5-18", controllerSid: "S-1-5-80-1-2-3-4-5",
  diskIdentifierHex: "3".repeat(32), virtualDiskBytes: 16 * 1024 * 1024, reservedDiskBytes: 80 * 1024 * 1024,
} as const;
const hash = (bytes: Buffer): string => {
  createHash("sha256").update(bytes.subarray(0, 992)).digest().copy(bytes, 992);
  return bytes.toString("hex");
};
function fixture(sequence = 1, previous = "0".repeat(64)): Buffer {
  const bytes = Buffer.alloc(1024);
  bytes.write("GCCELLP1", 0, "ascii"); bytes.writeUInt32LE(sequence, 8); bytes.writeUInt32LE(sequence, 12);
  for (const [offset, value] of [[16, previous], [48, plan.assignmentBindingSha256], [80, plan.profileSha256],
    [112, plan.diskIdentifierHex], [144, file(1)], [168, file(2)]] as const) Buffer.from(value, "hex").copy(bytes, offset);
  bytes.writeBigUInt64LE(BigInt(plan.virtualDiskBytes), 128); bytes.writeBigUInt64LE(BigInt(plan.reservedDiskBytes), 136);
  bytes.write(plan.cellName, 192, "ascii"); bytes.write(plan.ownerSid, 232, "ascii"); bytes.write(plan.controllerSid, 416, "ascii");
  if (sequence >= 3) for (let index = 0; index < 4; index++) Buffer.from(file(index + 3), "hex").copy(bytes, 600 + index * 24);
  if (sequence === 5) Buffer.from(file(7), "hex").copy(bytes, 696);
  return bytes;
}

describe("native provisioning record contract", () => {
  function mountedWorkspace() {
    const larger = { ...plan, virtualDiskBytes: 64 * 1024 ** 2, reservedDiskBytes: 128 * 1024 ** 2 };
    const records: string[] = [];
    for (let sequence = 1; sequence <= 5; sequence++) {
      const bytes = fixture(sequence, records.at(-1)?.slice(-64));
      bytes.writeBigUInt64LE(BigInt(larger.virtualDiskBytes), 128); bytes.writeBigUInt64LE(BigInt(larger.reservedDiskBytes), 136);
      records.push(hash(bytes));
    }
    return mountedWorkspaceExchangeFixture({ schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION,
      registryWorkspaceId: "default", assignmentId: "workspace", assignmentGeneration: 1, leaseRevision: 1,
      plan: larger, planSha256: remoteWorkerCellProvisioningPlanSha256(larger), records });
  }
  it("retains workspace intent and completion after all nineteen prior records on v7 only", () => {
    const full = mountedWorkspace(), anchor = remoteWorkerCellProvisioningMountedWorkspaceAnchor(full);
    const records = full.mountedWorkspaceRecords!;
    const checkpoints = records.map((record) => readRemoteWorkerCellMountedWorkspaceCheckpoint(anchor, record));
    for (const [index, next] of checkpoints.entries()) assertRemoteWorkerCellMountedWorkspaceSuccessor(anchor, checkpoints[index - 1], next);
    expect(checkpoints.map((next) => next.phase)).toEqual(["intent", "recorded"]);
    expect(checkpoints[0]!.workspaceCheckpoint.directoryIdentityHex).toEqual([]);
    expect(checkpoints[1]!.workspaceCheckpoint.directoryIdentityHex).toEqual([0xe8, 0xe9, 0xea, 0xeb].map((value) => "1032547698badcfe" + value.toString(16).repeat(16)));
    expect(Object.isFrozen(full.mountedWorkspaceRecords) && Object.isFrozen(checkpoints[1]!.workspaceCheckpoint.directoryIdentityHex)).toBe(true);
    expect(normalizeRemoteWorkerCellProvisioningExchange({ ...full, mountedWorkspaceRecords: records.slice(0, 1) }).mountedWorkspaceRecords).toHaveLength(1);
    for (const version of [1, 2, 3, 4, 5, 6])
      expect(() => normalizeRemoteWorkerCellProvisioningExchange({ ...full, schemaVersion: `goatcitadel.remote-worker-cell-provisioning-exchange.v${version}` })).toThrow();
    const { mountedWorkspaceRecords: omitted, ...legacy } = full;
    expect(omitted).toHaveLength(2);
    expect(normalizeRemoteWorkerCellProvisioningExchange({ ...legacy, schemaVersion: "goatcitadel.remote-worker-cell-provisioning-exchange.v6" }).mountRecords).toEqual(full.mountRecords);
    for (const length of [0, 1, 2, 3]) expect(() => normalizeRemoteWorkerCellProvisioningExchange({ ...full, mountRecords: full.mountRecords!.slice(0, length) })).toThrow();
    const selection = { kind: "cell.mounted-workspace.checkpoint", expectedSequence: 1, recordHex: records[1] };
    expect(normalizeRemoteWorkerCellProvisioningSubmission(selection)).toEqual(selection);
    for (const patch of [{ expectedSequence: 0 }, { path: "C:\\" }, { ready: true }, { recordHex: records[1] + "00" }])
      expect(() => normalizeRemoteWorkerCellProvisioningSubmission({ ...selection, ...patch })).toThrow();
  });
  it("refuses rehashed workspace ownership, identity, policy, name, phase and padding substitutions", () => {
    const full = mountedWorkspace(), anchor = remoteWorkerCellProvisioningMountedWorkspaceAnchor(full), records = full.mountedWorkspaceRecords!;
    const rehash = (bytes: Buffer) => { rehashVolumeFixture(bytes.subarray(280, 792)); return rehashVolumeFixture(bytes); };
    for (const offset of [0, 8, 12, 16, 48, 80, 112, 128, 136, 144, 168, 192, 216, 248, 264, 792, 991]) {
      const bytes = Buffer.from(records[0]!, "hex"); bytes[offset] = bytes[offset]! ^ 1;
      expect(() => readRemoteWorkerCellMountedWorkspaceCheckpoint(anchor, rehash(bytes)), `outer ${offset}`).toThrow();
    }
    for (const offset of [0, 8, 12, 16, 48, 80, 112, 151, 152, 176, 200, 224, 248, 272, 479]) {
      const bytes = Buffer.from(records[0]!, "hex"); bytes[280 + offset] = bytes[280 + offset]! ^ 1;
      expect(() => readRemoteWorkerCellMountedWorkspaceCheckpoint(anchor, rehash(bytes)), `inner ${offset}`).toThrow();
    }
    const recorded = readRemoteWorkerCellMountedWorkspaceCheckpoint(anchor, records[1]);
    for (const id of [recorded.workspaceCheckpoint.rootIdentityHex, recorded.workspaceCheckpoint.directoryIdentityHex[1]!,
      "0".repeat(48), file(7), "1032547698badcfe" + "0".repeat(32)]) {
      const bytes = Buffer.from(records[1]!, "hex"); Buffer.from(id, "hex").copy(bytes, 456);
      expect(() => readRemoteWorkerCellMountedWorkspaceCheckpoint(anchor, rehash(bytes))).toThrow();
    }
    const intent = readRemoteWorkerCellMountedWorkspaceCheckpoint(anchor, records[0]);
    expect(() => assertRemoteWorkerCellMountedWorkspaceSuccessor(anchor, undefined, recorded)).toThrow();
    expect(() => assertRemoteWorkerCellMountedWorkspaceSuccessor(anchor, intent, intent)).toThrow();
    for (const offset of [16, 296]) {
      const bytes = Buffer.from(records[1]!, "hex"); bytes[offset] = bytes[offset]! ^ 1;
      expect(() => assertRemoteWorkerCellMountedWorkspaceSuccessor(anchor, intent,
        readRemoteWorkerCellMountedWorkspaceCheckpoint(anchor, rehash(bytes)))).toThrow();
    }
  });
  it("does not trust frozen copies, sparse arrays, accessor fields or reordered workspace histories", () => {
    const full = mountedWorkspace(), anchor = remoteWorkerCellProvisioningMountedWorkspaceAnchor(full), records = full.mountedWorkspaceRecords!;
    expect(normalizeRemoteWorkerCellMountedWorkspaceAnchor(anchor)).toBe(anchor);
    for (const mountRecords of [[], anchor.mountRecords.slice(0, 3), [...anchor.mountRecords].reverse(), new Array(4)])
      expect(() => normalizeRemoteWorkerCellMountedWorkspaceAnchor(Object.freeze({ ...anchor, mountRecords }))).toThrow();
    for (const mountedWorkspaceRecords of [[records[1]], [...records].reverse(), [...records, records[1]], new Array(2), Object.assign([...records], { ready: true })])
      expect(() => normalizeRemoteWorkerCellProvisioningExchange({ ...full, mountedWorkspaceRecords })).toThrow();
    let called = false;
    const accessor = [...records]; Object.defineProperty(accessor, "0", { enumerable: true, get() { called = true; return records[0]; } });
    expect(() => normalizeRemoteWorkerCellProvisioningExchange({ ...full, mountedWorkspaceRecords: accessor })).toThrow();
    const anchorAccessor = { ...anchor }; Object.defineProperty(anchorAccessor, "cellName", { enumerable: true, get() { called = true; return anchor.cellName; } });
    expect(() => normalizeRemoteWorkerCellMountedWorkspaceAnchor(anchorAccessor)).toThrow();
    expect(called).toBe(false);
  });
  it("retains all mount prefixes after the complete protected history and refuses legacy mount fields", () => {
    const larger = { ...plan, virtualDiskBytes: 64 * 1024 ** 2, reservedDiskBytes: 128 * 1024 ** 2 };
    const records: string[] = [];
    for (let sequence = 1; sequence <= 5; sequence++) {
      const bytes = fixture(sequence, records.at(-1)?.slice(-64));
      bytes.writeBigUInt64LE(BigInt(larger.virtualDiskBytes), 128); bytes.writeBigUInt64LE(BigInt(larger.reservedDiskBytes), 136);
      records.push(hash(bytes));
    }
    const result = mountExchangeFixture({ schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION,
      registryWorkspaceId: "default", assignmentId: "mount", assignmentGeneration: 1, leaseRevision: 1,
      plan: larger, planSha256: remoteWorkerCellProvisioningPlanSha256(larger), records });
    const mountRecords = result.mountRecords!;
    expect(result.records).toEqual(records); expect(mountRecords).toHaveLength(4);
    expect(Object.isFrozen(mountRecords)).toBe(true);
    expect(normalizeRemoteWorkerCellProvisioningExchange(result)).toBe(result);
    expect(() => normalizeRemoteWorkerCellProvisioningExchange(Object.freeze({ ...result, planSha256: "f".repeat(64) }))).toThrow();
    for (let length = 1; length <= 4; length++)
      expect(normalizeRemoteWorkerCellProvisioningExchange({ ...result, mountRecords: mountRecords.slice(0, length) }).mountRecords).toHaveLength(length);
    for (const version of ["v1", "v2", "v3", "v4", "v5"])
      expect(() => normalizeRemoteWorkerCellProvisioningExchange({ ...result, schemaVersion: `goatcitadel.remote-worker-cell-provisioning-exchange.${version}` })).toThrow();
    const { mountRecords: omitted, ...legacy } = result;
    expect(omitted).toHaveLength(4);
    expect(normalizeRemoteWorkerCellProvisioningExchange({ ...legacy, schemaVersion: "goatcitadel.remote-worker-cell-provisioning-exchange.v5" }).protectionRecords).toEqual(result.protectionRecords);
    for (const protectionRecords of [[], result.protectionRecords!.slice(0, 1)])
      expect(() => normalizeRemoteWorkerCellProvisioningExchange({ ...result, protectionRecords })).toThrow();
    const submission = { kind: "cell.mount.checkpoint", expectedSequence: 3, recordHex: mountRecords[3] };
    expect(normalizeRemoteWorkerCellProvisioningSubmission(submission)).toEqual(submission);
  });
  it("preserves protection prefixes only after complete format history and on v5 exchanges", () => {
    const larger = { ...plan, virtualDiskBytes: 64 * 1024 ** 2, reservedDiskBytes: 128 * 1024 ** 2 };
    const records: string[] = [];
    for (let sequence = 1; sequence <= 5; sequence++) {
      const bytes = fixture(sequence, records.at(-1)?.slice(-64));
      bytes.writeBigUInt64LE(BigInt(larger.virtualDiskBytes), 128); bytes.writeBigUInt64LE(BigInt(larger.reservedDiskBytes), 136);
      records.push(hash(bytes));
    }
    const result = protectionExchangeFixture({ schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION,
      registryWorkspaceId: "default", assignmentId: "protection", assignmentGeneration: 1, leaseRevision: 1,
      plan: larger, planSha256: remoteWorkerCellProvisioningPlanSha256(larger), records });
    const protectionRecords = result.protectionRecords!;
    expect(result.records).toEqual(records); expect(result.volumeRecords).toHaveLength(6); expect(result.formatRecords).toHaveLength(2);
    expect(protectionRecords).toHaveLength(2); expect(Object.isFrozen(protectionRecords)).toBe(true);
    expect(normalizeRemoteWorkerCellProvisioningExchange({ ...result, protectionRecords: protectionRecords.slice(0, 1) }).protectionRecords).toHaveLength(1);
    for (const values of [[protectionRecords[1]], [protectionRecords[0], protectionRecords[0]], [...protectionRecords, protectionRecords[1]],
      new Array(1), Object.assign([...protectionRecords], { ready: true })])
      expect(() => normalizeRemoteWorkerCellProvisioningExchange({ ...result, protectionRecords: values })).toThrow();
    for (const formatRecords of [[], result.formatRecords!.slice(0, 1)])
      expect(() => normalizeRemoteWorkerCellProvisioningExchange({ ...result, formatRecords })).toThrow();
    let called = false; const getters = [...protectionRecords];
    Object.defineProperty(getters, "0", { enumerable: true, get() { called = true; return protectionRecords[0]; } });
    expect(() => normalizeRemoteWorkerCellProvisioningExchange({ ...result, protectionRecords: getters })).toThrow(); expect(called).toBe(false);
    for (const version of ["v1", "v2", "v3", "v4"])
      expect(() => normalizeRemoteWorkerCellProvisioningExchange({ ...result, schemaVersion: `goatcitadel.remote-worker-cell-provisioning-exchange.${version}` })).toThrow();
    const { protectionRecords: omitted, ...legacy } = result;
    expect(omitted).toHaveLength(2);
    expect(normalizeRemoteWorkerCellProvisioningExchange({ ...legacy, schemaVersion: "goatcitadel.remote-worker-cell-provisioning-exchange.v4" }).formatRecords).toEqual(result.formatRecords);
  });
  it("preserves format prefixes separately and refuses formatting on legacy exchange versions", () => {
    const larger = { ...plan, virtualDiskBytes: 64 * 1024 ** 2, reservedDiskBytes: 128 * 1024 ** 2 };
    const records: string[] = [];
    for (let sequence = 1; sequence <= 5; sequence++) {
      const bytes = fixture(sequence, records.at(-1)?.slice(-64));
      bytes.writeBigUInt64LE(BigInt(larger.virtualDiskBytes), 128); bytes.writeBigUInt64LE(BigInt(larger.reservedDiskBytes), 136);
      records.push(hash(bytes));
    }
    const result = formatExchangeFixture({ schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION,
      registryWorkspaceId: "default", assignmentId: "format", assignmentGeneration: 1, leaseRevision: 1,
      plan: larger, planSha256: remoteWorkerCellProvisioningPlanSha256(larger), records });
    expect(result.records).toEqual(records); expect(result.volumeRecords).toHaveLength(6); expect(result.formatRecords).toHaveLength(2);
    expect(Object.isFrozen(result.formatRecords)).toBe(true);
    const formatRecords = result.formatRecords!;
    expect(normalizeRemoteWorkerCellProvisioningExchange({ ...result, formatRecords: formatRecords.slice(0, 1) }).formatRecords).toHaveLength(1);
    for (const values of [[formatRecords[1]], [formatRecords[0], formatRecords[0]], [...formatRecords, formatRecords[1]], new Array(1),
      Object.assign([...formatRecords], { ready: true })])
      expect(() => normalizeRemoteWorkerCellProvisioningExchange({ ...result, formatRecords: values })).toThrow();
    let called = false; const getters = [...formatRecords];
    Object.defineProperty(getters, "0", { enumerable: true, get() { called = true; return formatRecords[0]; } });
    expect(() => normalizeRemoteWorkerCellProvisioningExchange({ ...result, formatRecords: getters })).toThrow(); expect(called).toBe(false);
    for (const version of ["v1", "v2", "v3"])
      expect(() => normalizeRemoteWorkerCellProvisioningExchange({ ...result, schemaVersion: `goatcitadel.remote-worker-cell-provisioning-exchange.${version}` })).toThrow();
    const { formatRecords: _formats, ...volume } = result;
    expect(normalizeRemoteWorkerCellProvisioningExchange({ ...volume, schemaVersion: "goatcitadel.remote-worker-cell-provisioning-exchange.v3" }).volumeRecords).toEqual(volume.volumeRecords);
    expect(() => normalizeRemoteWorkerCellProvisioningExchange({ ...result, volumeRecords: volume.volumeRecords!.slice(0, 5) })).toThrow();
    const submission = { kind: "cell.format.checkpoint", expectedSequence: 1, recordHex: formatRecords[1] };
    expect(normalizeRemoteWorkerCellProvisioningSubmission(submission)).toEqual(submission);
  });
  it("projects GPT identities only from completed sufficient-capacity records and preserves legacy bytes", () => {
    const larger = { ...plan, virtualDiskBytes: 64 * 1024 * 1024, reservedDiskBytes: 128 * 1024 * 1024 };
    const records: string[] = [];
    for (let sequence = 1; sequence <= 5; sequence++) {
      const bytes = fixture(sequence, records.at(-1)?.slice(-64));
      bytes.writeBigUInt64LE(BigInt(larger.virtualDiskBytes), 128); bytes.writeBigUInt64LE(BigInt(larger.reservedDiskBytes), 136);
      records.push(hash(bytes));
    }
    const input = { schemaVersion: "goatcitadel.remote-worker-cell-provisioning-exchange.v1", registryWorkspaceId: "default",
      assignmentId: "assignment", assignmentGeneration: 1, leaseRevision: 1, plan: larger,
      planSha256: remoteWorkerCellProvisioningPlanSha256(larger), records };
    const result = normalizeRemoteWorkerCellProvisioningExchange(input);
    expect(result.schemaVersion).toBe(REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION);
    expect(result.records).toEqual(records);
    expect(result.plan).toEqual(larger);
    expect(result.diskLayoutPlan).toMatchObject({ provisioningPlanSha256: input.planSha256,
      controlIdentityHex: file(4), backingIdentityHex: file(7) });
    const anchor = deriveRemoteWorkerCellVolumeAnchor(larger, records);
    expect(anchor).toEqual(remoteWorkerCellProvisioningVolumeAnchor(result));
    expect(Object.isFrozen(anchor)).toBe(true);
    for (const invalidRecords of [records.slice(0, 4), [...records, records[4]], records.slice().reverse(),
      new Array(5), Object.assign([...records], { extra: true }),
      Object.assign([...records], { [Symbol("unreviewed")]: true })]) {
      expect(() => deriveRemoteWorkerCellVolumeAnchor(larger, invalidRecords)).toThrow();
    }
    const getterRecords = [...records]; let anchorGetterRead = false;
    Object.defineProperty(getterRecords, "4", { enumerable: true, get() { anchorGetterRead = true; return records[4]; } });
    expect(() => deriveRemoteWorkerCellVolumeAnchor(larger, getterRecords)).toThrow();
    expect(anchorGetterRead).toBe(false);
    expect(() => deriveRemoteWorkerCellVolumeAnchor({ ...larger, profileSha256: "f".repeat(64) }, records)).toThrow();
    const smallRecords: string[] = [];
    for (let sequence = 1; sequence <= 5; sequence++) smallRecords.push(hash(fixture(sequence, smallRecords.at(-1)?.slice(-64))));
    expect(() => deriveRemoteWorkerCellVolumeAnchor(plan, smallRecords)).toThrow();
    expect(normalizeRemoteWorkerCellProvisioningExchange(result)).toEqual(result);
    expect(normalizeRemoteWorkerCellProvisioningExchange({ ...input, records: records.slice(0, 4) }).diskLayoutPlan).toBeUndefined();
    expect(() => normalizeRemoteWorkerCellProvisioningExchange({ ...input, records: records.slice(0, 4),
      diskLayoutPlan: result.diskLayoutPlan })).toThrow();
    expect(() => normalizeRemoteWorkerCellProvisioningExchange({ ...result,
      diskLayoutPlan: { ...result.diskLayoutPlan, gptDiskIdentifierHex: "1".repeat(32) } })).toThrow();
    expect(() => normalizeRemoteWorkerCellProvisioningExchange({ ...result,
      diskLayoutPlan: { ...result.diskLayoutPlan, provisioningPlanSha256: "1".repeat(64) } })).toThrow();
    expect(() => normalizeRemoteWorkerCellProvisioningExchange({ ...result, diskLayoutPlan: undefined })).toThrow();
    const volume = volumeExchangeFixture(result);
    expect(volume.volumeRecords).toHaveLength(6);
    expect(Object.isFrozen(volume.volumeRecords)).toBe(true);
    expect(volume.records).toEqual(result.records);
    for (const length of [1, 2, 3, 4, 5, 6]) {
      const prefix = volume.volumeRecords!.slice(0, length);
      expect(normalizeRemoteWorkerCellProvisioningExchange({ ...volume, volumeRecords: prefix }).volumeRecords).toEqual(prefix);
    }
    for (const patch of [{ records: result.records.slice(0, 4), diskLayoutPlan: undefined },
      { volumeRecords: volume.volumeRecords!.slice(1) }, { volumeRecords: [...volume.volumeRecords!, volume.volumeRecords![5]] },
      { schemaVersion: "goatcitadel.remote-worker-cell-provisioning-exchange.v2" },
      { volumeRecords: [volume.volumeRecords![0], volume.volumeRecords![0]] }]) {
      expect(() => normalizeRemoteWorkerCellProvisioningExchange({ ...volume, ...patch })).toThrow();
    }
    let accessed = false;
    const hostile = Object.defineProperty([...volume.volumeRecords!], "1", { enumerable: true,
      get() { accessed = true; return volume.volumeRecords![1]; } });
    expect(() => normalizeRemoteWorkerCellProvisioningExchange({ ...volume, volumeRecords: hostile })).toThrow();
    expect(accessed).toBe(false);
  });
  it("keeps preparation observations separate from Gateway profiles and one-time decisions", () => {
    const submission = { kind: "cell.provisioning.prepare", parentIdentityHex: file(1) };
    expect(normalizeRemoteWorkerCellPreparationSubmission(submission)).toEqual(submission);
    for (const change of [{ parentIdentityHex: "0".repeat(48) }, { parentIdentityHex: "1".repeat(47) },
      { capacity: {} }, { profileSha256: plan.profileSha256 }, { approved: true }, { provisioningOwner: "worker" },
      { kind: "cell.provisioning.snapshot" }, { get parentIdentityHex() { throw new Error("getter must not run"); } }]) {
      const changed = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(submission), ...Object.getOwnPropertyDescriptors(change) });
      expect(() => normalizeRemoteWorkerCellPreparationSubmission(changed)).toThrow("metadata is invalid");
    }
    const prepared = { schemaVersion: REMOTE_WORKER_CELL_PREPARATION_SCHEMA_VERSION, decision: "create_once",
      provisioningExpiresAt: "2099-01-01T00:00:00.000Z", exchange: { schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION,
        registryWorkspaceId: "default", assignmentId: "assignment", assignmentGeneration: 1, leaseRevision: 1,
        plan, planSha256: remoteWorkerCellProvisioningPlanSha256(plan), records: [] } };
    expect(normalizeRemoteWorkerCellPreparation(prepared)).toEqual(prepared);
    const records = [hash(fixture())];
    expect(() => normalizeRemoteWorkerCellPreparation({ ...prepared, exchange: { ...prepared.exchange, records } })).toThrow();
    expect(normalizeRemoteWorkerCellPreparation({ ...prepared, decision: "reconcile", exchange: { ...prepared.exchange, records } }).decision).toBe("reconcile");
    for (const patch of [{ decision: "created" }, { provisioningExpiresAt: "2099-01-01" }, { provisioningExpiresAt: "invalid" },
      { schemaVersion: "future" }, { creationToken: "untrusted" }]) {
      expect(() => normalizeRemoteWorkerCellPreparation({ ...prepared, ...patch })).toThrow();
    }
  });
  it("bounds the protected exchange and verifies every returned checkpoint before acknowledgement", () => {
    const first = hash(fixture());
    const second = hash(fixture(2, first.slice(-64)));
    const submission = { kind: "cell.provisioning.checkpoint", expectedSequence: 0, recordHex: first };
    expect(normalizeRemoteWorkerCellProvisioningSubmission(submission)).toEqual(submission);
    expect(normalizeRemoteWorkerCellProvisioningSubmission({ kind: "cell.provisioning.snapshot" }))
      .toEqual({ kind: "cell.provisioning.snapshot" });
    const exchange = { schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION,
      registryWorkspaceId: "default", assignmentId: "assignment", assignmentGeneration: 1, leaseRevision: 2,
      plan, planSha256: remoteWorkerCellProvisioningPlanSha256(plan), records: [first, second] };
    const normalized = normalizeRemoteWorkerCellProvisioningExchange(exchange);
    expect(normalized).toEqual(exchange);
    expect(Object.isFrozen(normalized.records)).toBe(true);
    expect(normalizeRemoteWorkerCellProvisioningExchange({ ...exchange, records: [] }).records).toEqual([]);
    for (const patch of [{ planSha256: "f".repeat(64) }, { leaseRevision: 0 }, { assignmentGeneration: 1.1 },
      { records: [second] }, { records: [first, first] }, { records: [first.slice(2)] },
      { records: Array(6).fill(first) }, { records: new Array(1) }, { provisioningOwner: "untrusted" },
      { registryWorkspaceId: " default" }]) {
      expect(() => normalizeRemoteWorkerCellProvisioningExchange({ ...exchange, ...patch })).toThrow();
    }
    let accessed = false;
    const records = [first];
    Object.defineProperty(records, "0", { enumerable: true, get: () => { accessed = true; return first; } });
    expect(() => normalizeRemoteWorkerCellProvisioningExchange({ ...exchange, records })).toThrow();
    for (const patch of [{ expectedSequence: 1 }, { recordHex: "invalid" }, { provisioningOwner: "worker" },
      { kind: "cell.provisioning.create" }, { get kind() { accessed = true; return "cell.provisioning.snapshot"; } }]) {
      const value = Object.defineProperties({ ...submission }, Object.getOwnPropertyDescriptors(patch));
      expect(() => normalizeRemoteWorkerCellProvisioningSubmission(value)).toThrow();
    }
    expect(accessed).toBe(false);
  });

  it("matches independent Node hashes and the five native phase layouts", () => {
    let previous: RemoteWorkerCellProvisioningCheckpoint | undefined;
    for (let sequence = 1; sequence <= 5; sequence++) {
      const value = readRemoteWorkerCellProvisioningCheckpoint(hash(fixture(sequence, previous?.recordSha256)));
      expect(value.plan).toEqual(plan);
      assertRemoteWorkerCellProvisioningSuccessor(plan, previous, value);
      expect(value.workspaceIdentityHex).toHaveLength(sequence >= 3 ? 4 : 0);
      expect(value.backingIdentityHex).toBe(sequence === 5 ? file(7) : undefined);
      expect(Object.isFrozen(value) && Object.isFrozen(value.plan) && Object.isFrozen(value.workspaceIdentityHex)).toBe(true);
      previous = value;
    }
  });

  it.each([
    ["wrong magic", (bytes: Buffer) => { bytes[0] = 0; }],
    ["future phase", (bytes: Buffer) => { bytes.writeUInt32LE(6, 8); bytes.writeUInt32LE(6, 12); }],
    ["mismatched sequence", (bytes: Buffer) => { bytes[12] = 2; }],
    ["nonzero padding", (bytes: Buffer) => { bytes[720] = 1; }],
    ["hidden string suffix", (bytes: Buffer) => { bytes[250] = 1; }],
    ["workspace before creation", (bytes: Buffer) => { bytes[600] = 1; }],
    ["disk before creation", (bytes: Buffer) => { bytes[696] = 1; }],
    ["foreign volume", (bytes: Buffer) => { bytes[168] = 9; }],
    ["journal aliases parent", (bytes: Buffer) => { bytes.copy(bytes, 168, 144, 168); }],
    ["missing journal identity", (bytes: Buffer) => { bytes.fill(0, 168, 192); }],
    ["unbounded capacity", (bytes: Buffer) => { bytes.writeBigUInt64LE(0xffffffffffffffffn, 136); }],
  ] as const)("rejects %s even with a recomputed record hash", (_name, change) => {
    const bytes = fixture(); change(bytes);
    expect(() => readRemoteWorkerCellProvisioningCheckpoint(hash(bytes))).toThrow();
  });

  it("rejects truncated records, broken hashes and a different plan or journal in the chain", () => {
    const first = readRemoteWorkerCellProvisioningCheckpoint(hash(fixture()));
    expect(() => readRemoteWorkerCellProvisioningCheckpoint(first.recordHex.slice(2))).toThrow();
    expect(() => readRemoteWorkerCellProvisioningCheckpoint(`ff${first.recordHex.slice(2)}`)).toThrow();
    const changed = fixture(2, first.recordSha256);
    changed[112] = changed[112]! ^ 1;
    expect(() => assertRemoteWorkerCellProvisioningSuccessor(plan, first,
      readRemoteWorkerCellProvisioningCheckpoint(hash(changed)))).toThrow();
    const wrongJournal = fixture(2, first.recordSha256);
    Buffer.from(file(8), "hex").copy(wrongJournal, 168);
    expect(() => assertRemoteWorkerCellProvisioningSuccessor(plan, first,
      readRemoteWorkerCellProvisioningCheckpoint(hash(wrongJournal)))).toThrow();
  });

  it("refuses extra metadata, getters, unsupported principals and unreserved disk capacity", () => {
    for (const value of [
      { ...plan, credential: "private" }, { ...plan, get ownerSid() { throw new Error("getter must not run"); } },
      { ...plan, ownerSid: "S-1-5-80-1-2-3-4-5" }, { ...plan, controllerSid: "S-1-5-20" },
      { ...plan, controllerSid: "S-1-5-80-01-2-3-4-5" }, { ...plan, controllerSid: "S-1-5-80-4294967296-2-3-4-5" },
      { ...plan, reservedDiskBytes: plan.virtualDiskBytes }, { ...plan, virtualDiskBytes: plan.virtualDiskBytes + 1 },
    ]) expect(() => normalizeRemoteWorkerCellProvisioningPlan(value)).toThrow("metadata is invalid");
  });

  it("binds the plan to the exact canonical worker, assignment, profile and claim", () => {
    const binding = { registryWorkspaceId: "default", assignmentId: "assignment", assignmentGeneration: 1, cellId: "cell",
      workerId: "worker", workerGeneration: 1, profileSha256: plan.profileSha256, provisioningOwner: "controller",
      provisioningLeaseExpiresAt: "2099-01-01T00:00:00.000Z" };
    const expected = remoteWorkerCellProvisioningBindingSha256(binding);
    for (const change of [{ workerGeneration: 2 }, { assignmentGeneration: 2 }, { profileSha256: "4".repeat(64) },
      { provisioningOwner: "restarted" }, { provisioningLeaseExpiresAt: "2099-01-01T00:00:01.000Z" }]) {
      expect(remoteWorkerCellProvisioningBindingSha256({ ...binding, ...change })).not.toBe(expected);
    }
  });
});
