import { describe, expect, it, vi } from "vitest";
import { exchangeRemoteWorkerNativePoolPage as exchange, type RemoteWorkerNativePoolPageInput } from "./remote-worker-native-pool-exchange.js";
function fixture(kind: RemoteWorkerNativePoolPageInput["submission"]["kind"]) {
  const input = { registryWorkspaceId: "registry", assignmentId: "assignment", assignmentGeneration: 1, leaseRevision: 1,
    leaseTokenSha256: "a".repeat(64), protectedAuthority: { credentialAuthority: { credentialGeneration: 1 }, meshAdmission: { admissionGeneration: 1 } },
    submission: { kind, offset: 0, snapshotSha256: "b".repeat(64) } } as unknown as RemoteWorkerNativePoolPageInput;
  const page = { snapshotSha256: "b".repeat(64), offset: 0, byteLength: 1, bytesHex: "7b" };
  return { input, page };
}
describe.each(["cell.native_pool.page", "cell.native_pool.cleanup.page"] as const)("protected %s exchange", kind => {
  it("freezes authority and selection before calling the owner", async () => {
    const { input, page } = fixture(kind);
    const read = vi.fn(async (command: RemoteWorkerNativePoolPageInput) => {
      expect(Object.isFrozen(command.submission)).toBe(true);
      expect(Object.isFrozen(command.protectedAuthority.credentialAuthority)).toBe(true);
      return page;
    });
    expect(await exchange({ read }, input)).toEqual(page);
    expect(read).toHaveBeenCalledOnce();
  });
  it.each(["before", "after"])("withholds a cancelled %s read", async stage => {
    const { input, page } = fixture(kind), controller = new AbortController();
    if (stage === "before") controller.abort();
    const read = vi.fn(async () => { controller.abort(); return page; });
    await expect(exchange({ read }, { ...input, signal: controller.signal })).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
  });
  it("rejects missing owner, different snapshot and wrong offset", async () => {
    const { input, page } = fixture(kind);
    await expect(exchange(undefined, input)).rejects.toThrow(/unavailable/u);
    await expect(exchange({ read: async () => ({ ...page, snapshotSha256: "c".repeat(64) }) }, input)).rejects.toThrow();
    await expect(exchange({ read: async () => page }, { ...input, submission: { ...input.submission, offset: 32768 } })).rejects.toThrow();
  });
});
