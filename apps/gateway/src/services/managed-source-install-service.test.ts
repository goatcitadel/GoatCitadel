import { describe, expect, it, vi } from "vitest";
import type { ManagedSourceInstallRecord } from "@goatcitadel/storage";
import { ManagedSourceInstallService, type ManagedSourceInspection } from "./managed-source-install-service.js";

const inspection: ManagedSourceInspection = {
  canonicalRoot: "F:\\private\\goatcitadel",
  label: "goatcitadel",
  repositoryIdentitySha256: "a".repeat(64),
  baselineSha: "b".repeat(40),
  baselineTree: "c".repeat(40),
  platform: "win32",
  volumeId: "d".repeat(64),
};

describe("ManagedSourceInstallService", () => {
  it("revalidates the private root before activation and never includes it in public projection", async () => {
    let record: ManagedSourceInstallRecord | undefined;
    const repository = {
      getActive: vi.fn(() => undefined),
      createCandidate: vi.fn((input: typeof inspection) => {
        record = {
          ...input,
          installId: "install-1",
          status: "candidate" as const,
          revision: 1,
          registeredAt: "2026-08-13T00:00:00.000Z",
          lastVerifiedAt: "2026-08-13T00:00:00.000Z",
          updatedAt: "2026-08-13T00:00:00.000Z",
        };
        return record;
      }),
      get: vi.fn(() => record!),
      activate: vi.fn(() => {
        record = { ...record!, status: "active", revision: 2 };
        return record;
      }),
      deleteCandidate: vi.fn(() => true),
    };
    const inspect = vi.fn(async () => inspection);
    const service = new ManagedSourceInstallService(repository, inspect);

    const candidate = await service.stageCandidate(inspection.canonicalRoot);
    const active = await service.activateCandidate(candidate.installId, candidate.revision);
    const projected = service.project(active);

    expect(inspect).toHaveBeenCalledTimes(2);
    expect(projected).toMatchObject({ installId: "install-1", status: "active", liveApplySupported: true });
    expect(JSON.stringify(projected)).not.toContain("private");
    expect(JSON.stringify(projected)).not.toContain("canonicalRoot");
  });

  it("fails closed when the selected baseline drifts before confirmation", async () => {
    let record: ManagedSourceInstallRecord | undefined;
    let calls = 0;
    const service = new ManagedSourceInstallService(
      {
        getActive: () => undefined,
        createCandidate: (input) =>
          (record = {
            ...input,
            installId: "install-2",
            status: "candidate",
            revision: 1,
            registeredAt: "2026-08-13T00:00:00.000Z",
            lastVerifiedAt: "2026-08-13T00:00:00.000Z",
            updatedAt: "2026-08-13T00:00:00.000Z",
          }),
        get: () => record!,
        activate: () => {
          throw new Error("must not activate");
        },
        deleteCandidate: () => true,
      },
      async () => ({ ...inspection, baselineSha: (++calls === 1 ? "b" : "e").repeat(40) }),
    );

    const candidate = await service.stageCandidate(inspection.canonicalRoot);
    await expect(service.activateCandidate(candidate.installId, candidate.revision)).rejects.toThrow(
      /changed after it was selected/i,
    );
  });
});
