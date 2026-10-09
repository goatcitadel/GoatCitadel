import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetBackupAttemptsForTests, commitBackup, readBackupReview } from "./health-backup-action";
const api = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), access: vi.fn(), base: "http://fixture", revision: 1 }));
vi.mock("@goatcitadel/mission-control-shared/api/system", () => ({ createBackup: api.create, listBackups: api.list }));
vi.mock("@goatcitadel/mission-control-shared/api/shell-client", () => ({ fetchGatewayCurrentAccess: api.access }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => api.base, getGatewayAccessRevision: () => api.revision }));
const manifest = { backupId: "backup-a", createdAt: "2026-10-06T01:00:00Z", appVersion: "1.0", rootDir: "fixture", files: [{ path: "data/index.db", sizeBytes: 2, sha256: "a".repeat(64) }] };
const receipt = { backupId: manifest.backupId, outputPath: "fixture/backups/backup-a", bytes: 2, manifest };
beforeEach(() => { vi.resetAllMocks(); __resetBackupAttemptsForTests(); api.revision = 1; api.base = "http://fixture"; api.access.mockResolvedValue({ operatorAccess: true }); api.list.mockResolvedValue({ items: [] }); api.create.mockResolvedValue(receipt); });
describe("Gateway backup admission", () => {
  it("requires current operator access and owner read before review", async () => {
    api.access.mockResolvedValue({ operatorAccess: false });
    await expect(readBackupReview()).rejects.toThrow("operator access");
    expect(api.create).not.toHaveBeenCalled();
  });
  it("does not send after cancel, Gateway switch or access revision change", async () => {
    const review = await readBackupReview();
    await commitBackup(review, () => false);
    api.revision++;
    await commitBackup(review, () => true);
    api.base = "http://other";
    await commitBackup(review, () => true);
    expect(api.create).not.toHaveBeenCalled();
  });
  it("locks duplicate calls while creation is pending and confirms exact manifest readback", async () => {
    let finish!: (value: typeof receipt) => void;
    api.create.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const review = await readBackupReview();
    const first = commitBackup(review, () => true);
    await vi.waitFor(() => expect(api.create).toHaveBeenCalledOnce());
    await commitBackup(review, () => true);
    expect(api.create).toHaveBeenCalledOnce();
    api.list.mockResolvedValue({ items: [structuredClone(manifest)] }); finish(receipt);
    await first;
    expect(api.list).toHaveBeenCalledTimes(2);
  });
  it("withholds retries after a lost response or mismatched canonical manifest", async () => {
    const review = await readBackupReview();
    api.create.mockRejectedValue(new Error("Lost response"));
    await commitBackup(review, () => true); await commitBackup(review, () => true);
    expect(api.create).toHaveBeenCalledOnce();
    __resetBackupAttemptsForTests(); api.create.mockResolvedValue(receipt);
    api.list.mockResolvedValue({ items: [{ ...manifest, files: [] }] });
    await commitBackup(review, () => true); await commitBackup(review, () => true);
    expect(api.create).toHaveBeenCalledTimes(2);
  });
  it("rechecks operator authority before dispatch and sends no mutation if revoked", async () => {
    const review = await readBackupReview(); api.access.mockResolvedValue({ operatorAccess: false });
    await commitBackup(review, () => true);
    expect(api.create).not.toHaveBeenCalled();
  });
});
