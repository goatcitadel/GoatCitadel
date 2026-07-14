import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  TaskActivityCreateInput,
  TaskCreateInput,
  TaskDeliverableCreateInput,
  TaskRecord,
  TaskUpdateInput,
} from "@goatcitadel/contracts";
import { verifyEvidenceRecords } from "./review-readiness-release-evidence.js";
import { REQUIRED_RELEASE_PROOF_LANE_NAMES, ReviewReadinessService } from "./review-readiness-service.js";
import type { RuntimeReleaseTrustReader, RuntimeReleaseTrustSnapshot } from "./runtime-release-trust-service.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const ASSET_CONTENT = "signed GoatCitadel release asset\n";
const PROOF_CONTENT = "commit-bound GoatCitadel proof bundle\n";
const REPORTED_SIGNATURE_CONTENT = "renamed bytes without cryptographic verification\n";
const ASSET_SHA = createHash("sha256").update(ASSET_CONTENT).digest("hex");
const PROOF_SHA = createHash("sha256").update(PROOF_CONTENT).digest("hex");
const REPORTED_SIGNATURE_SHA = createHash("sha256").update(REPORTED_SIGNATURE_CONTENT).digest("hex");

describe("ReviewReadinessService", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("imports review findings idempotently into task records", () => {
    const tasks: TaskRecord[] = [];
    const activities: TaskActivityCreateInput[] = [];
    const deliverables: TaskDeliverableCreateInput[] = [];
    const service = new ReviewReadinessService({
      rootDir: process.cwd(),
      taskLifecycleService: {
        listTasks: vi.fn(() => tasks),
        createTask: vi.fn((input: TaskCreateInput) => {
          const task: TaskRecord = {
            taskId: `task-${tasks.length + 1}`,
            workspaceId: input.workspaceId,
            title: input.title,
            description: input.description,
            status: input.status ?? "inbox",
            priority: input.priority ?? "normal",
            createdBy: input.createdBy,
            createdAt: "2026-05-27T00:00:00.000Z",
            updatedAt: "2026-05-27T00:00:00.000Z",
          };
          tasks.push(task);
          return task;
        }),
        updateTask: vi.fn((taskId: string, input: TaskUpdateInput) => {
          const task = tasks.find((candidate) => candidate.taskId === taskId);
          if (!task) throw new Error("missing task");
          Object.assign(task, input);
          return task;
        }),
        appendTaskActivity: vi.fn((_taskId: string, input: TaskActivityCreateInput) => {
          activities.push(input);
          return {
            activityId: `activity-${activities.length}`,
            taskId: _taskId,
            activityType: input.activityType,
            message: input.message,
            metadata: input.metadata,
            createdAt: "2026-05-27T00:00:00.000Z",
          };
        }),
        appendTaskDeliverable: vi.fn((_taskId: string, input: TaskDeliverableCreateInput) => {
          deliverables.push(input);
          return {
            deliverableId: `deliverable-${deliverables.length}`,
            taskId: _taskId,
            deliverableType: input.deliverableType,
            title: input.title,
            path: input.path,
            description: input.description,
            createdAt: "2026-05-27T00:00:00.000Z",
          };
        }),
      },
    });

    const first = service.importFindings({
      actorId: "reviewer",
      findings: [
        {
          source: "external-review",
          component: "skills",
          title: "Missing catalog proof",
          files: ["skills/bundled/coding/SKILL.md"],
          priority: "high",
          evidenceRef: "artifact:review-1",
        },
      ],
    });
    const second = service.importFindings({
      actorId: "reviewer",
      findings: [
        {
          source: "external-review",
          component: "skills",
          title: "Missing catalog proof",
          files: ["skills/bundled/coding/SKILL.md"],
          priority: "urgent",
          evidenceRef: "artifact:review-1",
        },
      ],
    });

    expect(first.created).toHaveLength(1);
    expect(second.created).toHaveLength(0);
    expect(second.updated).toHaveLength(1);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: "review", priority: "urgent", createdBy: "review-readiness" });
    expect(activities.map((activity) => activity.activityType)).toEqual(["diagnostic", "diagnostic"]);
    expect(deliverables).toHaveLength(2);
  });

  it("recognizes skill catalog proof nested inside the fast verification manifest", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-review-readiness-"));
    tempDirs.push(rootDir);
    const artifactDir = path.join(rootDir, "artifacts", "verification", "2026-05-27T00-00-00Z-fast");
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(
      path.join(artifactDir, "manifest.json"),
      JSON.stringify({
        lane: "fast",
        status: "passed",
        scenarios: [{ id: "fast.skills-catalog", title: "Skill catalog coverage", status: "passed" }],
      }),
    );
    const service = new ReviewReadinessService({
      rootDir,
      taskLifecycleService: {
        listTasks: vi.fn(() => []),
        createTask: vi.fn(),
        updateTask: vi.fn(),
        appendTaskActivity: vi.fn(),
        appendTaskDeliverable: vi.fn(),
      } as never,
    });

    const readiness = service.getReadiness();
    expect(readiness.lanes.find((lane) => lane.lane === "skills-catalog")).toMatchObject({
      status: "current",
      artifactRef: path.join("artifacts", "verification", "2026-05-27T00-00-00Z-fast"),
    });
  });

  it("projects release artifact proof rows from release-certificate.json when present", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-review-readiness-"));
    tempDirs.push(rootDir);
    const releaseDir = path.join(rootDir, "artifacts", "release");
    fs.mkdirSync(releaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(releaseDir, "release-certificate.json"),
      JSON.stringify({
        commit: "abc123",
        releaseWorkflow: { name: "Release Installers and Bundles" },
        requiredLanes: [{ directRun: { head_sha: "abc123" } }],
        releaseAssets: [
          { fileName: "GoatCitadel-linux-x64.tar.gz", sha256: ASSET_SHA, sizeBytes: 321 },
          { fileName: "GoatCitadel-linux-x64.tar.gz.sig", sha256: PROOF_SHA, sizeBytes: 21 },
        ],
      }),
    );
    const service = new ReviewReadinessService({
      rootDir,
      taskLifecycleService: {
        listTasks: vi.fn(() => []),
        createTask: vi.fn(),
        updateTask: vi.fn(),
        appendTaskActivity: vi.fn(),
        appendTaskDeliverable: vi.fn(),
      } as never,
    });

    const releaseProof = service.getReadiness().releaseProof;
    expect(releaseProof).toMatchObject({
      sourceCertificate: "release-certificate.json",
      exactShaStatus: "exact",
    });
    expect(releaseProof?.artifacts.find((artifact) => artifact.name === "GoatCitadel-linux-x64.tar.gz")).toMatchObject({
      name: "GoatCitadel-linux-x64.tar.gz",
      platformArch: "linux/x64",
      signatureStatus: "unverified",
      sha256: ASSET_SHA,
      sizeBytes: 321,
      sourceWorkflow: "Release Installers and Bundles",
    });
  });

  it("distinguishes development, source, and packaged runtime identities", () => {
    const rootDir = makeIdentityRoot(tempDirs);
    const development = createIdentityService(rootDir, { NODE_ENV: "development" }).getRuntimeIdentity();
    const source = createIdentityService(rootDir, { NODE_ENV: "production" }).getRuntimeIdentity();

    const appDir = path.join(rootDir, "packaged-app");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "release-manifest.json"),
      JSON.stringify({ schemaVersion: 1, version: "1.0.0", sourceCommit: SHA_A, sourceModified: false }),
    );
    const packaged = createIdentityService(rootDir, { NODE_ENV: "production" }, appDir).getRuntimeIdentity();

    expect(development).toMatchObject({
      kind: "development",
      version: "1.0.0",
      buildSha: SHA_A,
      integrity: "clean",
      identitySource: "git_checkout",
    });
    expect(source.kind).toBe("source");
    expect(packaged).toMatchObject({
      kind: "packaged",
      version: "1.0.0",
      buildSha: SHA_A,
      integrity: "unknown",
      identitySource: "packaged_manifest",
    });
  });

  it("ignores environment-authored build and release claims for source identity", () => {
    const rootDir = makeIdentityRoot(tempDirs);
    const identity = createIdentityService(rootDir, {
      NODE_ENV: "production",
      GOATCITADEL_BUILD_SHA: SHA_B,
      GOATCITADEL_BUILD_VERSION: "9.9.9",
      GOATCITADEL_RELEASE_VERIFIED: "true",
      VITE_GOATCITADEL_BUILD_SHA: SHA_B,
      VITE_GOATCITADEL_RELEASE_VERIFIED: "true",
    }).getRuntimeIdentity();

    expect(identity).toMatchObject({
      kind: "source",
      version: "1.0.0",
      buildSha: SHA_A,
      integrity: "clean",
      identitySource: "git_checkout",
      release: { verified: false, certificateState: "absent" },
    });
  });

  it("does not trust identity fields from an unsupported packaged manifest schema", () => {
    const rootDir = makeIdentityRoot(tempDirs);
    const appDir = path.join(rootDir, "packaged-app");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "release-manifest.json"),
      JSON.stringify({ schemaVersion: 999, version: "1.0.0", sourceCommit: SHA_A, sourceModified: false }),
    );
    writePackagedEvidence(appDir, validCertificate());

    const identity = createIdentityService(rootDir, { NODE_ENV: "production" }, appDir).getRuntimeIdentity();
    expect(identity).toMatchObject({
      kind: "packaged",
      version: "unknown",
      integrity: "unknown",
      identitySource: "unavailable",
      release: { verified: false },
    });
    expect(identity.buildSha).toBeUndefined();
    expect(identity.release.reasonCodes).toEqual(
      expect.arrayContaining([
        "identity_sha_unavailable",
        "identity_integrity_unavailable",
        "certificate_version_mismatch",
      ]),
    );
  });

  it("accepts a minimal installed sidecar only after authenticated immutable-payload proof", () => {
    const rootDir = makeIdentityRoot(tempDirs);
    const appDir = path.join(rootDir, "packaged-app");
    const evidenceDir = path.join(appDir, "release-evidence");
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "release-manifest.json"),
      JSON.stringify({ schemaVersion: 2, product: "GoatCitadel", version: "1.0.0", sourceCommit: SHA_A }),
    );
    const certificate = { ...validCertificate(), schemaVersion: 2 };
    fs.writeFileSync(path.join(evidenceDir, "release-certificate.json"), JSON.stringify(certificate));
    fs.writeFileSync(
      path.join(evidenceDir, "release-certificate.sigstore.json"),
      JSON.stringify({ mediaType: "bundle" }),
    );

    const verifiedTrust = buildReleaseTrustSnapshot("verified", "verified", certificate);
    const verifiedIdentity = createIdentityService(
      rootDir,
      { NODE_ENV: "production" },
      appDir,
      "",
      releaseTrustReader(verifiedTrust),
    ).getRuntimeIdentity();
    expect(verifiedIdentity).toMatchObject({
      integrity: "clean",
      release: {
        verified: true,
        certificateAttestation: { status: "verified", issuer: ISSUER },
        runtimePayloadIntegrity: { status: "verified", target: "windows-x64" },
        reasonCodes: [],
      },
    });
    expect(fs.existsSync(path.join(evidenceDir, "release-assets"))).toBe(false);
    expect(fs.existsSync(path.join(evidenceDir, "proof-bundle"))).toBe(false);

    const pendingIdentity = createIdentityService(
      rootDir,
      { NODE_ENV: "production" },
      appDir,
      "",
      releaseTrustReader(buildReleaseTrustSnapshot("pending", "pending")),
    ).getRuntimeIdentity();
    expect(pendingIdentity).toMatchObject({
      integrity: "unknown",
      release: {
        verified: false,
        reasonCodes: expect.arrayContaining(["certificate_attestation_pending", "runtime_payload_integrity_pending"]),
      },
    });

    const mismatchIdentity = createIdentityService(
      rootDir,
      { NODE_ENV: "production" },
      appDir,
      "",
      releaseTrustReader(buildReleaseTrustSnapshot("verified", "mismatch", certificate)),
    ).getRuntimeIdentity();
    expect(mismatchIdentity).toMatchObject({
      integrity: "modified",
      release: {
        verified: false,
        reasonCodes: expect.arrayContaining(["runtime_payload_integrity_mismatch"]),
      },
    });
  });

  it("fails closed when a custom trust reader claims verified attestation without complete proof fields", () => {
    const rootDir = makeIdentityRoot(tempDirs);
    const appDir = path.join(rootDir, "packaged-app");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "release-manifest.json"),
      JSON.stringify({ schemaVersion: 2, product: "GoatCitadel", version: "1.0.0", sourceCommit: SHA_A }),
    );
    const certificate = { ...validCertificate(), schemaVersion: 2 };
    const contradictory = buildReleaseTrustSnapshot("verified", "verified", certificate);
    contradictory.verifiedAt = undefined;
    contradictory.certificate.issuer = undefined;
    contradictory.certificate.identity = undefined;

    const identity = createIdentityService(
      rootDir,
      { NODE_ENV: "production" },
      appDir,
      "",
      releaseTrustReader(contradictory),
    ).getRuntimeIdentity();

    expect(identity).toMatchObject({
      integrity: "unknown",
      release: {
        verified: false,
        certificateAttestation: { status: "verified", verifiedAt: undefined },
        reasonCodes: expect.arrayContaining([
          "certificate_attestation_unavailable",
          "runtime_payload_integrity_unavailable",
        ]),
      },
    });
  });

  it("fails closed when a custom trust reader claims verified payload with incomplete or unbounded proof fields", () => {
    const rootDir = makeIdentityRoot(tempDirs);
    const appDir = path.join(rootDir, "packaged-app");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "release-manifest.json"),
      JSON.stringify({ schemaVersion: 2, product: "GoatCitadel", version: "1.0.0", sourceCommit: SHA_A }),
    );
    const certificate = { ...validCertificate(), schemaVersion: 2 };
    const contradictory = buildReleaseTrustSnapshot("verified", "verified", certificate);
    contradictory.payload.target = undefined;
    contradictory.payload.manifestSha256 = undefined;
    contradictory.payload.fileCount = 0;
    contradictory.payload.totalBytes = Number.MAX_SAFE_INTEGER;

    const identity = createIdentityService(
      rootDir,
      { NODE_ENV: "production" },
      appDir,
      "",
      releaseTrustReader(contradictory),
    ).getRuntimeIdentity();

    expect(identity).toMatchObject({
      integrity: "unknown",
      release: {
        verified: false,
        runtimePayloadIntegrity: {
          status: "verified",
          target: undefined,
          manifestSha256: undefined,
          fileCount: 0,
          totalBytes: Number.MAX_SAFE_INTEGER,
        },
        reasonCodes: expect.arrayContaining(["runtime_payload_integrity_unavailable"]),
      },
    });
  });

  it("forces asynchronous runtime-release verification before returning refreshed readiness", async () => {
    const rootDir = makeIdentityRoot(tempDirs);
    const appDir = path.join(rootDir, "packaged-app");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "release-manifest.json"),
      JSON.stringify({
        schemaVersion: 2,
        product: "GoatCitadel",
        version: "1.0.0",
        sourceCommit: SHA_A,
        sourceModified: false,
      }),
    );
    const certificate = { ...validCertificate(), schemaVersion: 2 };
    let current = buildReleaseTrustSnapshot("pending", "pending");
    const verified = buildReleaseTrustSnapshot("verified", "verified", certificate);
    const requestRefresh = vi.fn(async () => {
      current = verified;
      return current;
    });
    const reader: RuntimeReleaseTrustReader = {
      getSnapshot: () => current,
      requestRefresh,
    };
    const service = createIdentityService(rootDir, { NODE_ENV: "production" }, appDir, "", reader);

    const readiness = await service.refreshRuntimeReleaseTrust();

    expect(requestRefresh).toHaveBeenCalledWith({ force: true, reason: "operator" });
    expect(readiness.runtimeIdentity).toMatchObject({
      kind: "packaged",
      integrity: "clean",
      release: {
        certificateAttestation: { status: "verified" },
        runtimePayloadIntegrity: { status: "verified", verifiedAt: "2026-07-14T18:00:00.000Z" },
      },
    });
  });

  it("fails closed for absent and malformed release certificates", () => {
    const rootDir = makeIdentityRoot(tempDirs);
    const service = createIdentityService(rootDir, { NODE_ENV: "production" });
    expect(service.getRuntimeIdentity().release).toMatchObject({
      verified: false,
      certificateState: "absent",
      reasonCodes: ["certificate_absent"],
    });

    writeCertificate(rootDir, "{not-json");
    expect(service.getRuntimeIdentity().release).toMatchObject({
      verified: false,
      certificateState: "malformed",
      reasonCodes: ["certificate_malformed"],
    });
  });

  it("keeps an exact self-consistent certificate unverified without publisher attestation and payload proof", () => {
    const rootDir = makeIdentityRoot(tempDirs);
    writeCertificate(rootDir, validCertificate());

    const identity = createIdentityService(rootDir, { NODE_ENV: "production" }).getRuntimeIdentity();
    expect(identity.release).toMatchObject({
      verified: false,
      certificateState: "parsed",
      certificateCommit: SHA_A,
      certificateVersion: "1.0.0",
      requiredProof: {
        total: REQUIRED_RELEASE_PROOF_LANE_NAMES.length,
        passed: REQUIRED_RELEASE_PROOF_LANE_NAMES.length,
        missing: 0,
        failed: 0,
        stale: 0,
      },
      acceptedFailureCount: 0,
      reasonCodes: ["certificate_attestation_missing", "runtime_payload_integrity_unverified"],
    });
  });

  it("treats an unverified fixed-name attestation bundle as invalid instead of trusting its bytes", () => {
    const rootDir = makeIdentityRoot(tempDirs);
    writeCertificate(rootDir, validCertificate());
    const service = createIdentityService(rootDir, { NODE_ENV: "production" });
    expect(service.getRuntimeIdentity().release.reasonCodes).toContain("certificate_attestation_missing");

    fs.writeFileSync(
      path.join(rootDir, "artifacts", "release", "release-certificate.sigstore.json"),
      JSON.stringify({ verified: true, issuer: "attacker", subject: "attacker" }),
    );

    const release = service.getRuntimeIdentity().release;
    expect(release.verified).toBe(false);
    expect(release.reasonCodes).toContain("certificate_attestation_invalid");
    expect(release.reasonCodes).not.toContain("certificate_attestation_missing");
    expect(release.reasonCodes).toContain("runtime_payload_integrity_unverified");
  });

  it("keeps renamed .sig and .pem assets display-only and never treats filenames as trust proof", () => {
    const rootDir = makeIdentityRoot(tempDirs);
    const certificate = validCertificate();
    certificate.releaseAssets[0].signature = "self-declared-signature";
    certificate.releaseAssets[0].signaturePath = "GoatCitadel-1.0.0-windows-x64.exe.sig";
    certificate.releaseAssets.push(
      {
        relativePath: "GoatCitadel-1.0.0-windows-x64.exe.sig",
        sha256: REPORTED_SIGNATURE_SHA,
        sizeBytes: Buffer.byteLength(REPORTED_SIGNATURE_CONTENT),
      },
      {
        relativePath: "GoatCitadel-1.0.0-windows-x64.exe.pem",
        sha256: REPORTED_SIGNATURE_SHA,
        sizeBytes: Buffer.byteLength(REPORTED_SIGNATURE_CONTENT),
      },
    );
    writeCertificate(rootDir, certificate);
    fs.writeFileSync(
      path.join(rootDir, "release-artifacts", "GoatCitadel-1.0.0-windows-x64.exe.sig"),
      REPORTED_SIGNATURE_CONTENT,
    );
    fs.writeFileSync(
      path.join(rootDir, "release-artifacts", "GoatCitadel-1.0.0-windows-x64.exe.pem"),
      REPORTED_SIGNATURE_CONTENT,
    );

    const readiness = createIdentityService(rootDir, { NODE_ENV: "production" }).getReadiness();
    expect(
      readiness.releaseProof?.artifacts.find((artifact) => artifact.name === "GoatCitadel-1.0.0-windows-x64.exe")
        ?.signatureStatus,
    ).toBe("unverified");
    expect(readiness.releaseProof?.artifacts.map((artifact) => artifact.name)).toEqual(
      expect.arrayContaining(["GoatCitadel-1.0.0-windows-x64.exe.sig", "GoatCitadel-1.0.0-windows-x64.exe.pem"]),
    );
    expect(readiness.runtimeIdentity.release.verified).toBe(false);
    expect(readiness.runtimeIdentity.release.reasonCodes).toEqual(
      expect.arrayContaining(["certificate_attestation_missing", "runtime_payload_integrity_unverified"]),
    );
  });

  it.each([
    {
      label: "certificate SHA mismatch",
      mutate: (certificate: Record<string, any>) => {
        certificate.commit = SHA_B;
        certificate.exactShaStatus.targetCommit = SHA_B;
        certificate.requiredLanes[0].directRun.headSha = SHA_B;
      },
      reason: "certificate_sha_mismatch",
    },
    {
      label: "stale required proof",
      mutate: (certificate: Record<string, any>) => {
        certificate.requiredLanes[0].directRun.headSha = SHA_B;
      },
      reason: "required_proof_stale",
    },
    {
      label: "failed required proof",
      mutate: (certificate: Record<string, any>) => {
        certificate.requiredLanes[0].status = "failure";
      },
      reason: "required_proof_failed",
    },
    {
      label: "failed selected workflow run hidden behind a green lane summary",
      mutate: (certificate: Record<string, any>) => {
        certificate.requiredLanes[0].directRun.status = "completed";
        certificate.requiredLanes[0].directRun.conclusion = "failure";
      },
      reason: "required_proof_failed",
    },
    {
      label: "umbrella substitution for a direct-only lane",
      mutate: (certificate: Record<string, any>) => {
        const lane = certificate.requiredLanes.find((item: Record<string, any>) => item.name === "verify:fast");
        lane.substitutedByReleaseProof = true;
        lane.directRun = null;
        lane.releaseProofRun = { headSha: SHA_A, status: "success", conclusion: "success" };
      },
      reason: "required_proof_failed",
    },
    {
      label: "accepted failures",
      mutate: (certificate: Record<string, any>) => {
        certificate.acceptedFailures = ["unsigned installer accepted"];
      },
      reason: "accepted_failures_present",
    },
  ])("does not verify $label", ({ mutate, reason }) => {
    const rootDir = makeIdentityRoot(tempDirs);
    const certificate = validCertificate();
    mutate(certificate);
    writeCertificate(rootDir, certificate);

    const release = createIdentityService(rootDir, { NODE_ENV: "production" }).getRuntimeIdentity().release;
    expect(release.verified).toBe(false);
    expect(release.reasonCodes).toContain(reason);
  });

  it("fails closed for non-exact SHAs, version drift, dirty or unknown source state, and more than eight caveats", () => {
    const malformedShaRoot = makeIdentityRoot(tempDirs);
    const malformedShaCertificate = validCertificate();
    malformedShaCertificate.commit = "a".repeat(39);
    writeCertificate(malformedShaRoot, malformedShaCertificate);
    expect(
      createIdentityService(malformedShaRoot, { NODE_ENV: "production" }).getRuntimeIdentity().release,
    ).toMatchObject({
      verified: false,
      certificateState: "malformed",
    });

    const versionRoot = makeIdentityRoot(tempDirs);
    const versionCertificate = validCertificate();
    versionCertificate.version = "2.0.0";
    writeCertificate(versionRoot, versionCertificate);
    expect(
      createIdentityService(versionRoot, { NODE_ENV: "production" }).getRuntimeIdentity().release.reasonCodes,
    ).toContain("certificate_version_mismatch");

    const dirtyRoot = makeIdentityRoot(tempDirs);
    writeCertificate(dirtyRoot, validCertificate());
    const dirtyIdentity = createIdentityService(
      dirtyRoot,
      { NODE_ENV: "production" },
      undefined,
      " M source.ts",
    ).getRuntimeIdentity();
    expect(dirtyIdentity).toMatchObject({ integrity: "modified", release: { verified: false } });
    expect(dirtyIdentity.release.reasonCodes).toContain("source_modified");

    const unknownRoot = makeIdentityRoot(tempDirs);
    writeCertificate(unknownRoot, validCertificate());
    const unknownIdentity = createIdentityService(
      unknownRoot,
      { NODE_ENV: "production" },
      undefined,
      null,
    ).getRuntimeIdentity();
    expect(unknownIdentity).toMatchObject({ integrity: "unknown", release: { verified: false } });
    expect(unknownIdentity.release.reasonCodes).toContain("identity_integrity_unavailable");

    const caveatRoot = makeIdentityRoot(tempDirs);
    const caveatCertificate = validCertificate();
    caveatCertificate.acceptedFailures = Array.from({ length: 9 }, (_, index) => `accepted failure ${index + 1}`);
    writeCertificate(caveatRoot, caveatCertificate);
    const caveatRelease = createIdentityService(caveatRoot, { NODE_ENV: "production" }).getRuntimeIdentity().release;
    expect(caveatRelease).toMatchObject({ verified: false, acceptedFailureCount: 9 });
    expect(caveatRelease.acceptedFailures).toHaveLength(8);
    expect(caveatRelease.reasonCodes).toContain("accepted_failures_present");
  });

  it("fails closed when certificate-bound release assets or proof bundles are missing or tampered", () => {
    const rootDir = makeIdentityRoot(tempDirs);
    writeCertificate(rootDir, validCertificate());

    fs.rmSync(path.join(rootDir, "release-artifacts", "GoatCitadel-1.0.0-windows-x64.exe"));
    let release = createIdentityService(rootDir, { NODE_ENV: "production" }).getRuntimeIdentity().release;
    expect(release.verified).toBe(false);
    expect(release.reasonCodes).toContain("release_asset_evidence_missing");

    fs.writeFileSync(
      path.join(rootDir, "release-artifacts", "GoatCitadel-1.0.0-windows-x64.exe"),
      "tampered release asset\n",
    );
    fs.writeFileSync(path.join(rootDir, "artifacts", "release", "package", "release-proof.zip"), "tampered proof\n");
    release = createIdentityService(rootDir, { NODE_ENV: "production" }).getRuntimeIdentity().release;
    expect(release.verified).toBe(false);
    expect(release.reasonCodes).toContain("release_asset_evidence_mismatch");
    expect(release.reasonCodes).toContain("proof_bundle_evidence_mismatch");
  });

  it("invalidates cached release trust when packaged evidence metadata changes", () => {
    const rootDir = makeIdentityRoot(tempDirs);
    const appDir = path.join(rootDir, "packaged-app");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "release-manifest.json"),
      JSON.stringify({ schemaVersion: 1, version: "1.0.0", sourceCommit: SHA_A, sourceModified: false }),
    );
    writePackagedEvidence(appDir, validCertificate());
    const service = createIdentityService(rootDir, { NODE_ENV: "production" }, appDir);
    expect(service.getRuntimeIdentity().release).toMatchObject({
      verified: false,
      reasonCodes: expect.arrayContaining([
        "certificate_attestation_missing",
        "runtime_payload_integrity_unverified",
        "identity_integrity_unavailable",
      ]),
    });

    fs.writeFileSync(
      path.join(appDir, "release-evidence", "release-assets", "GoatCitadel-1.0.0-windows-x64.exe"),
      "tampered asset with different metadata\n",
    );
    const release = service.getRuntimeIdentity().release;
    expect(release.verified).toBe(false);
    expect(release.reasonCodes).toContain("release_asset_evidence_mismatch");
  });

  it("does not cache release trust when an oversized evidence tree exceeds the fingerprint bound", () => {
    const rootDir = makeIdentityRoot(tempDirs);
    const appDir = path.join(rootDir, "packaged-app");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "release-manifest.json"),
      JSON.stringify({ schemaVersion: 1, version: "1.0.0", sourceCommit: SHA_A, sourceModified: false }),
    );
    const certificate = validCertificate();
    certificate.releaseAssets[0].relativePath = "target/asset.exe";
    writePackagedEvidence(appDir, certificate);
    const assetsRoot = path.join(appDir, "release-evidence", "release-assets");
    const targetDir = path.join(assetsRoot, "target");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "asset.exe"), ASSET_CONTENT);
    for (let index = 0; index < 1_025; index += 1) {
      fs.mkdirSync(path.join(assetsRoot, `padding-${String(index).padStart(3, "0")}`));
    }

    const service = createIdentityService(rootDir, { NODE_ENV: "production" }, appDir);
    const readdirSpy = vi.spyOn(fs, "readdirSync");
    const opendirSpy = vi.spyOn(fs, "opendirSync");
    const lstatSpy = vi.spyOn(fs, "lstatSync");
    try {
      expect(service.getRuntimeIdentity().release).toMatchObject({
        verified: false,
        reasonCodes: expect.arrayContaining([
          "certificate_attestation_missing",
          "runtime_payload_integrity_unverified",
          "identity_integrity_unavailable",
        ]),
      });
      expect(readdirSpy).not.toHaveBeenCalled();
      expect(opendirSpy).toHaveBeenCalledTimes(1);
      expect(lstatSpy.mock.calls.length).toBeLessThan(600);
    } finally {
      readdirSpy.mockRestore();
      opendirSpy.mockRestore();
      lstatSpy.mockRestore();
    }

    fs.writeFileSync(path.join(targetDir, "asset.exe"), "tampered asset with different metadata\n");
    const release = service.getRuntimeIdentity().release;
    expect(release.verified).toBe(false);
    expect(release.reasonCodes).toContain("release_asset_evidence_mismatch");
  });

  it("rejects certificate evidence routed through a symlink or junction", () => {
    const rootDir = makeIdentityRoot(tempDirs);
    const outsideDir = path.join(rootDir, "outside");
    const assetsRoot = path.join(rootDir, "release-artifacts");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.mkdirSync(assetsRoot, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "asset.exe"), ASSET_CONTENT);
    fs.symlinkSync(outsideDir, path.join(assetsRoot, "linked"), process.platform === "win32" ? "junction" : "dir");
    const certificate = validCertificate();
    certificate.releaseAssets = [
      {
        relativePath: "linked/asset.exe",
        sha256: ASSET_SHA,
        sizeBytes: Buffer.byteLength(ASSET_CONTENT),
      },
    ];
    writeCertificate(rootDir, certificate);

    const release = createIdentityService(rootDir, { NODE_ENV: "production" }).getRuntimeIdentity().release;
    expect(release.verified).toBe(false);
    expect(release.reasonCodes).toContain("release_evidence_path_invalid");
  });

  it("rejects a directory replacement between path resolution and descriptor open", () => {
    const rootDir = makeIdentityRoot(tempDirs);
    const assetsRoot = path.join(rootDir, "release-assets");
    const nestedRoot = path.join(assetsRoot, "nested");
    const outsideRoot = path.join(rootDir, "outside-assets");
    fs.mkdirSync(nestedRoot, { recursive: true });
    fs.mkdirSync(outsideRoot, { recursive: true });
    fs.writeFileSync(path.join(nestedRoot, "asset.exe"), ASSET_CONTENT);
    fs.writeFileSync(path.join(outsideRoot, "asset.exe"), ASSET_CONTENT);

    const originalOpenSync = fs.openSync.bind(fs);
    const openSpy = vi.spyOn(fs, "openSync").mockImplementationOnce((filePath, flags, mode) => {
      fs.rmSync(nestedRoot, { recursive: true, force: true });
      fs.symlinkSync(outsideRoot, nestedRoot, process.platform === "win32" ? "junction" : "dir");
      return originalOpenSync(filePath, flags, mode);
    });
    try {
      const result = verifyEvidenceRecords(
        [
          {
            relativePath: "nested/asset.exe",
            sha256: ASSET_SHA,
            sizeBytes: Buffer.byteLength(ASSET_CONTENT),
          },
        ],
        assetsRoot,
        rootDir,
      );
      expect(result).toMatchObject({ invalidPath: true });
    } finally {
      openSpy.mockRestore();
    }
  });

  it("deduplicates legacy evidence paths and never hashes file contents on the identity request path", () => {
    const rootDir = makeIdentityRoot(tempDirs);
    writeCertificate(rootDir, validCertificate());
    const assetsRoot = path.join(rootDir, "release-artifacts");
    const asset = {
      relativePath: "GoatCitadel-1.0.0-windows-x64.exe",
      sha256: ASSET_SHA,
      sizeBytes: Buffer.byteLength(ASSET_CONTENT),
    };
    const readSpy = vi.spyOn(fs, "readSync");
    try {
      expect(verifyEvidenceRecords([asset], assetsRoot, rootDir)).toEqual({
        invalidPath: false,
        missing: false,
        mismatch: false,
      });
      expect(readSpy).not.toHaveBeenCalled();

      expect(verifyEvidenceRecords([asset, { ...asset }], assetsRoot, rootDir)).toMatchObject({ invalidPath: true });
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
    }
  });

  it("rejects a legacy evidence inventory whose unique declared bytes exceed the aggregate bound", () => {
    const rootDir = makeIdentityRoot(tempDirs);
    writeCertificate(rootDir, validCertificate());
    const assetsRoot = path.join(rootDir, "release-artifacts");
    const oversizedInventory = ["missing-a", "missing-b", "missing-c"].map((name) => ({
      relativePath: `${name}.bin`,
      sha256: ASSET_SHA,
      sizeBytes: 400 * 1024 * 1024,
    }));

    expect(verifyEvidenceRecords(oversizedInventory, assetsRoot, rootDir)).toMatchObject({
      missing: true,
      mismatch: true,
    });
  });

  it("does not promote the installed packaged evidence layout before immutable payload verification exists", () => {
    const rootDir = makeIdentityRoot(tempDirs);
    const appDir = path.join(rootDir, "packaged-app");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "release-manifest.json"),
      JSON.stringify({ schemaVersion: 1, version: "1.0.0", sourceCommit: SHA_A, sourceModified: false }),
    );
    writePackagedEvidence(appDir, validCertificate());

    const identity = createIdentityService(rootDir, { NODE_ENV: "production" }, appDir).getRuntimeIdentity();
    expect(identity.kind).toBe("packaged");
    expect(identity.release).toMatchObject({
      verified: false,
      reasonCodes: expect.arrayContaining([
        "certificate_attestation_missing",
        "runtime_payload_integrity_unverified",
        "identity_integrity_unavailable",
      ]),
    });
  });

  it("cannot report verified when an installed payload is modified under a self-authored manifest", () => {
    const rootDir = makeIdentityRoot(tempDirs);
    const appDir = path.join(rootDir, "packaged-app");
    const payloadPath = path.join(appDir, "gateway", "dist", "main.js");
    fs.mkdirSync(path.dirname(payloadPath), { recursive: true });
    fs.writeFileSync(payloadPath, "original installed payload\n");
    fs.writeFileSync(
      path.join(appDir, "release-manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        version: "1.0.0",
        sourceCommit: SHA_A,
        sourceModified: false,
        checksums: {
          "app/gateway/dist/main.js": createHash("sha256").update("original installed payload\n").digest("hex"),
        },
      }),
    );
    writePackagedEvidence(appDir, validCertificate());

    const service = createIdentityService(rootDir, { NODE_ENV: "production" }, appDir);
    fs.writeFileSync(payloadPath, "attacker-modified installed payload\n");
    const identity = service.getRuntimeIdentity();

    expect(identity.integrity).toBe("unknown");
    expect(identity.release.verified).toBe(false);
    expect(identity.release.reasonCodes).toEqual(
      expect.arrayContaining(["certificate_attestation_missing", "runtime_payload_integrity_unverified"]),
    );
  });

  it("redacts and bounds certificate-controlled caveats and artifact fields", () => {
    const rootDir = makeIdentityRoot(tempDirs);
    const certificate = validCertificate();
    certificate.acceptedFailures = [
      `Bearer ghp_${"x".repeat(64)} C:\\Users\\private\\release.log ${"detail ".repeat(80)}`,
    ];
    certificate.releaseAssets[0].name = `C:\\Users\\private\\${"artifact-".repeat(40)}.zip`;
    writeCertificate(rootDir, certificate);

    const readiness = createIdentityService(rootDir, { NODE_ENV: "production" }).getReadiness();
    expect(readiness.runtimeIdentity.release.verified).toBe(false);
    expect(readiness.runtimeIdentity.release.acceptedFailures[0]?.length).toBeLessThanOrEqual(240);
    expect(readiness.runtimeIdentity.release.acceptedFailures[0]).not.toContain("ghp_");
    expect(readiness.runtimeIdentity.release.acceptedFailures[0]).not.toContain("C:\\Users\\private");
    expect(readiness.releaseProof?.artifacts[0]?.name.length).toBeLessThanOrEqual(160);
    expect(readiness.releaseProof?.artifacts[0]?.name).not.toContain("Users");
    expect(JSON.stringify(readiness)).not.toContain("x".repeat(32));
  });
});

function makeIdentityRoot(tempDirs: string[]): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-build-identity-"));
  tempDirs.push(rootDir);
  fs.writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ version: "1.0.0" }));
  return rootDir;
}

function createIdentityService(
  rootDir: string,
  runtimeEnv: Readonly<Record<string, string | undefined>>,
  runtimeAppDir?: string,
  gitStatus: string | null = "",
  releaseTrust?: RuntimeReleaseTrustReader,
): ReviewReadinessService {
  return new ReviewReadinessService({
    rootDir,
    runtimeAppDir,
    runtimeCwd: rootDir,
    runtimeEnv,
    releaseTrust,
    gitRunner: (args) => {
      const command = args.join(" ");
      if (command === "rev-parse --abbrev-ref HEAD") return "main";
      if (command === "rev-parse HEAD") return SHA_A;
      if (command === "status --porcelain") return gitStatus ?? undefined;
      return undefined;
    },
    taskLifecycleService: {
      listTasks: vi.fn(() => []),
      createTask: vi.fn(),
      updateTask: vi.fn(),
      appendTaskActivity: vi.fn(),
      appendTaskDeliverable: vi.fn(),
    } as never,
  });
}

const ISSUER = "https://token.actions.githubusercontent.com";

function buildReleaseTrustSnapshot(
  certificateStatus: RuntimeReleaseTrustSnapshot["certificate"]["status"],
  payloadStatus: RuntimeReleaseTrustSnapshot["payload"]["status"],
  authenticatedCertificate?: Readonly<Record<string, unknown>>,
): RuntimeReleaseTrustSnapshot {
  return {
    revision: 1,
    checkedAt: "2026-07-14T18:00:00.000Z",
    verifiedAt: certificateStatus === "verified" ? "2026-07-14T18:00:00.000Z" : undefined,
    inputFingerprint: "f".repeat(64),
    certificate: {
      status: certificateStatus,
      issuer: certificateStatus === "verified" ? ISSUER : undefined,
      identity:
        certificateStatus === "verified"
          ? "https://github.com/goatcitadel/GoatCitadel/.github/workflows/release-installers.yml@refs/tags/v1.0.0"
          : undefined,
    },
    payload: {
      status: payloadStatus,
      target: payloadStatus === "verified" || payloadStatus === "mismatch" ? "windows-x64" : undefined,
      manifestSha256: payloadStatus === "verified" || payloadStatus === "mismatch" ? "f".repeat(64) : undefined,
      fileCount: payloadStatus === "verified" || payloadStatus === "mismatch" ? 2 : undefined,
      totalBytes: payloadStatus === "verified" || payloadStatus === "mismatch" ? 20 : undefined,
    },
    authenticatedCertificate,
  };
}

function releaseTrustReader(snapshot: RuntimeReleaseTrustSnapshot): RuntimeReleaseTrustReader {
  return {
    getSnapshot: () => snapshot,
    requestRefresh: vi.fn(async () => snapshot),
  };
}

function validCertificate(): Record<string, any> {
  return {
    schemaVersion: 1,
    product: "GoatCitadel",
    version: "1.0.0",
    commit: SHA_A,
    generatedAt: "2026-07-13T12:00:00.000Z",
    exactShaStatus: { status: "matched", targetCommit: SHA_A },
    requiredLanes: REQUIRED_RELEASE_PROOF_LANE_NAMES.map((name) => ({
      name,
      required: true,
      status: "success",
      substitutedByReleaseProof: false,
      directRun: { headSha: SHA_A, status: "success", conclusion: "success" },
    })),
    acceptedFailures: [],
    releaseAssets: [
      {
        relativePath: "GoatCitadel-1.0.0-windows-x64.exe",
        sha256: ASSET_SHA,
        sizeBytes: Buffer.byteLength(ASSET_CONTENT),
      },
    ],
    proofBundle: {
      relativePath: "release-proof.zip",
      sha256: PROOF_SHA,
      sizeBytes: Buffer.byteLength(PROOF_CONTENT),
    },
  };
}

function writeCertificate(rootDir: string, value: string | Record<string, any>): void {
  const releaseDir = path.join(rootDir, "artifacts", "release");
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.writeFileSync(
    path.join(releaseDir, "release-certificate.json"),
    typeof value === "string" ? value : JSON.stringify(value),
  );
  if (typeof value !== "string") {
    fs.mkdirSync(path.join(rootDir, "release-artifacts"), { recursive: true });
    fs.mkdirSync(path.join(releaseDir, "package"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "release-artifacts", "GoatCitadel-1.0.0-windows-x64.exe"), ASSET_CONTENT);
    fs.writeFileSync(path.join(releaseDir, "package", "release-proof.zip"), PROOF_CONTENT);
  }
}

function writePackagedEvidence(appDir: string, certificate: Record<string, any>): void {
  const evidenceRoot = path.join(appDir, "release-evidence");
  fs.mkdirSync(path.join(evidenceRoot, "release-assets"), { recursive: true });
  fs.mkdirSync(path.join(evidenceRoot, "proof-bundle"), { recursive: true });
  fs.writeFileSync(path.join(evidenceRoot, "release-certificate.json"), JSON.stringify(certificate));
  fs.writeFileSync(path.join(evidenceRoot, "release-assets", "GoatCitadel-1.0.0-windows-x64.exe"), ASSET_CONTENT);
  fs.writeFileSync(path.join(evidenceRoot, "proof-bundle", "release-proof.zip"), PROOF_CONTENT);
}
