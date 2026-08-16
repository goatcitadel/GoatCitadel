import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GovernedFileHandlePortRefusalError,
  GovernedFileHandlePortUncertainError,
  captureGovernedFileEntry,
  governedFileHandlePortDiagnostics,
  publishGovernedFileEntry,
  removeGovernedFileEntry,
  restoreGovernedFileEntry,
  validateGovernedFileHandlePortResponse,
  type GovernedFileCaptureEvidence,
} from "./governed-file-windows-handle-port.js";

const SCHEMA = "goatcitadel.governed-file-windows-handle-port.v1";
const ROOT = "C:\\GoatCitadel\\config";
const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function observation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    volumeSerial: "0000000000000001",
    fileId: "00000000000000000000000000000002",
    sizeBytes: 3,
    linkCount: 1,
    attributes: 0x20,
    reparseTag: 0,
    lastWriteTime: "133969248000000001",
    changeTime: "133969248000000002",
    ...overrides,
  };
}

function captureResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA,
    operation: "capture",
    status: "ok",
    rootPath: ROOT,
    relativePath: "budgets.json",
    parentBefore: observation({ attributes: 0x10, sizeBytes: 0 }),
    parentAfter: observation({ attributes: 0x10, sizeBytes: 0 }),
    present: true,
    entry: observation(),
    contentBase64: Buffer.from("abc").toString("base64"),
    sha256: sha256("abc"),
    ...overrides,
  };
}

function publishResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA,
    operation: "publish",
    status: "ok",
    rootPath: ROOT,
    relativePath: "budgets.json",
    parentBefore: observation({ attributes: 0x10, sizeBytes: 0 }),
    parentAfter: observation({ attributes: 0x10, sizeBytes: 0 }),
    priorPresent: true,
    priorSha256: sha256("abc"),
    published: observation({ fileId: "00000000000000000000000000000003", sizeBytes: 4 }),
    publishedSha256: sha256("abcd"),
    ...overrides,
  };
}

describe("governed file handle port protocol", () => {
  it("accepts only exact, identity-stable capture evidence", () => {
    const evidence = validateGovernedFileHandlePortResponse(captureResponse(), {
      operation: "capture",
      rootPath: ROOT,
      relativePath: "budgets.json",
    }) as GovernedFileCaptureEvidence;
    expect(evidence.present).toBe(true);
    expect(evidence.content?.toString("utf8")).toBe("abc");
    expect(evidence.sha256).toBe(sha256("abc"));

    for (const mutated of [
      captureResponse({ rootPath: "C:\\GoatCitadel\\other" }),
      captureResponse({ operation: "publish" }),
      captureResponse({ sha256: sha256("tampered") }),
      captureResponse({ parentAfter: observation({ attributes: 0x10, sizeBytes: 0, fileId: "0".repeat(31) + "9" }) }),
      captureResponse({ entry: observation({ reparseTag: 0xa000000c }) }),
      captureResponse({ entry: observation({ linkCount: 2 }) }),
      captureResponse({ unexpected: true }),
    ]) {
      expect(() =>
        validateGovernedFileHandlePortResponse(mutated, {
          operation: "capture",
          rootPath: ROOT,
          relativePath: "budgets.json",
        }),
      ).toThrow(/Governed file handle port/u);
    }

    const absent = validateGovernedFileHandlePortResponse(
      captureResponse({ present: false, entry: null, contentBase64: "", sha256: "" }),
      { operation: "capture", rootPath: ROOT, relativePath: "budgets.json" },
    ) as GovernedFileCaptureEvidence;
    expect(absent).toMatchObject({ present: false, entry: null, content: null, sha256: null });
    expect(() =>
      validateGovernedFileHandlePortResponse(captureResponse({ present: false }), {
        operation: "capture",
        rootPath: ROOT,
        relativePath: "budgets.json",
      }),
    ).toThrow(/absent capture carried content/u);
  });

  it("binds publish evidence to the expected prior state and hashes", () => {
    const evidence = validateGovernedFileHandlePortResponse(publishResponse(), {
      operation: "publish",
      rootPath: ROOT,
      relativePath: "budgets.json",
      expectedPrior: { present: true, sha256: sha256("abc") },
    });
    expect(evidence).toMatchObject({
      priorPresent: true,
      priorSha256: sha256("abc"),
      publishedSha256: sha256("abcd"),
      renameMechanism: "posix_handle_rename",
    });

    expect(() =>
      validateGovernedFileHandlePortResponse(publishResponse(), {
        operation: "publish",
        rootPath: ROOT,
        relativePath: "budgets.json",
        expectedPrior: { present: true, sha256: sha256("different") },
      }),
    ).toThrow(/prior hash binding/u);
    expect(() =>
      validateGovernedFileHandlePortResponse(publishResponse(), {
        operation: "publish",
        rootPath: ROOT,
        relativePath: "budgets.json",
        expectedPrior: { present: false },
      }),
    ).toThrow(/prior presence binding/u);
  });

  it("maps typed refusal and uncertain envelopes to their exact error classes", () => {
    expect(() =>
      validateGovernedFileHandlePortResponse(
        { schemaVersion: SCHEMA, operation: "publish", status: "refused", reason: "reparse_refused" },
        {
          operation: "publish",
          rootPath: ROOT,
          relativePath: "budgets.json",
          expectedPrior: { present: false },
        },
      ),
    ).toThrow(GovernedFileHandlePortRefusalError);
    expect(() =>
      validateGovernedFileHandlePortResponse(
        { schemaVersion: SCHEMA, operation: "publish", status: "uncertain", reason: "entry_witness_mismatch" },
        {
          operation: "publish",
          rootPath: ROOT,
          relativePath: "budgets.json",
          expectedPrior: { present: false },
        },
      ),
    ).toThrow(GovernedFileHandlePortUncertainError);
    expect(() =>
      validateGovernedFileHandlePortResponse(
        { schemaVersion: SCHEMA, operation: "publish", status: "refused", reason: "made_up_reason" },
        {
          operation: "publish",
          rootPath: ROOT,
          relativePath: "budgets.json",
          expectedPrior: { present: false },
        },
      ),
    ).toThrow(/refusal reason was invalid/u);
    expect(() =>
      validateGovernedFileHandlePortResponse(
        { schemaVersion: SCHEMA, operation: "capture", status: "refused", reason: "reparse_refused" },
        {
          operation: "publish",
          rootPath: ROOT,
          relativePath: "budgets.json",
          expectedPrior: { present: false },
        },
      ),
    ).toThrow(/response binding was invalid/u);
  });

  it("publishes fixed, secret-free helper diagnostics", () => {
    const diagnostics = governedFileHandlePortDiagnostics();
    expect(diagnostics).toMatchObject({
      executableKind: "system32_windows_powershell",
      relativeHandleWalker: true,
      posixRenameByHandle: true,
      reparseRefusal: true,
      maximumEntryBytes: 1024 * 1024,
      nativeFixedVolumeRootOnly: true,
    });
    expect(JSON.stringify(diagnostics)).not.toContain("powershell.exe");
  });

  it.runIf(process.platform !== "win32")("is unavailable off Windows and fails closed", async () => {
    await expect(captureGovernedFileEntry(ROOT, "budgets.json")).rejects.toThrow(/unavailable on this platform/u);
  });
});

describe.runIf(process.platform === "win32")("governed file handle port live Windows proofs", () => {
  async function scratch(prefix: string): Promise<string> {
    // Keep native-handle proofs on the checkout volume. Some test sandboxes
    // expose os.tmpdir() through mediated file APIs while intentionally
    // denying the helper's direct NtCreateFile parent walk.
    const root = await mkdtemp(join(process.cwd(), prefix));
    cleanupRoots.push(root);
    return root;
  }

  it("captures, publishes, and restores through pinned relative handles", async () => {
    const root = await scratch("goat-governed-port-roundtrip-");
    await mkdir(join(root, "config"));
    const entryPath = join(root, "config", "budgets.json");
    const original = Buffer.from('{\n  "mode": "balanced"\n}\n');
    await writeFile(entryPath, original);

    const capture = await captureGovernedFileEntry(root, "config/budgets.json", { deadlineMs: 60_000 });
    expect(capture.present).toBe(true);
    expect(capture.content).toEqual(original);
    expect(capture.sha256).toBe(sha256(original));

    const replacement = Buffer.from('{\n  "mode": "saver"\n}\n');
    const published = await publishGovernedFileEntry(
      {
        rootPath: root,
        relativePath: "config/budgets.json",
        expectedParent: { volumeSerial: capture.parent.volumeSerial, fileId: capture.parent.fileId },
        expectedPrior: { present: true, sha256: capture.sha256 as string },
        content: replacement,
      },
      { deadlineMs: 60_000 },
    );
    expect(published.publishedSha256).toBe(sha256(replacement));
    expect(published.priorSha256).toBe(capture.sha256);
    await expect(readFile(entryPath)).resolves.toEqual(replacement);

    const restored = await restoreGovernedFileEntry(
      {
        rootPath: root,
        relativePath: "config/budgets.json",
        expectedParent: { volumeSerial: capture.parent.volumeSerial, fileId: capture.parent.fileId },
        expectedPrior: { present: true, sha256: sha256(replacement) },
        capturedContent: capture.content as Buffer,
      },
      { deadlineMs: 60_000 },
    );
    expect(restored.publishedSha256).toBe(capture.sha256);
    await expect(readFile(entryPath)).resolves.toEqual(original);
  }, 180_000);

  it("creates an absent entry and removes it again under the same CAS discipline", async () => {
    const root = await scratch("goat-governed-port-create-");
    const absent = await captureGovernedFileEntry(root, "budgets.json", { deadlineMs: 60_000 });
    expect(absent).toMatchObject({ present: false, entry: null, content: null, sha256: null });

    const content = Buffer.from('{\n  "mode": "power"\n}\n');
    const published = await publishGovernedFileEntry(
      {
        rootPath: root,
        relativePath: "budgets.json",
        expectedParent: { volumeSerial: absent.parent.volumeSerial, fileId: absent.parent.fileId },
        expectedPrior: { present: false },
        content,
      },
      { deadlineMs: 60_000 },
    );
    expect(published.priorPresent).toBe(false);
    await expect(readFile(join(root, "budgets.json"))).resolves.toEqual(content);

    await expect(
      publishGovernedFileEntry(
        {
          rootPath: root,
          relativePath: "budgets.json",
          expectedParent: { volumeSerial: absent.parent.volumeSerial, fileId: absent.parent.fileId },
          expectedPrior: { present: false },
          content,
        },
        { deadlineMs: 60_000 },
      ),
    ).rejects.toMatchObject({ reason: "presence_conflict" });

    const removed = await removeGovernedFileEntry(
      {
        rootPath: root,
        relativePath: "budgets.json",
        expectedParent: { volumeSerial: absent.parent.volumeSerial, fileId: absent.parent.fileId },
        expectedSha256: sha256(content),
      },
      { deadlineMs: 60_000 },
    );
    expect(removed.removed).toBe(true);
    const after = await captureGovernedFileEntry(root, "budgets.json", { deadlineMs: 60_000 });
    expect(after.present).toBe(false);
  }, 180_000);

  it("refuses a concurrent content swap through the exact prior-byte CAS and leaves the swap untouched", async () => {
    const root = await scratch("goat-governed-port-cas-");
    const entryPath = join(root, "budgets.json");
    await writeFile(entryPath, Buffer.from("original"));
    const capture = await captureGovernedFileEntry(root, "budgets.json", { deadlineMs: 60_000 });

    const swapped = Buffer.from("swapped-by-a-concurrent-writer");
    await writeFile(entryPath, swapped);
    await expect(
      publishGovernedFileEntry(
        {
          rootPath: root,
          relativePath: "budgets.json",
          expectedParent: { volumeSerial: capture.parent.volumeSerial, fileId: capture.parent.fileId },
          expectedPrior: { present: true, sha256: capture.sha256 as string },
          content: Buffer.from("attacker-must-not-land"),
        },
        { deadlineMs: 60_000 },
      ),
    ).rejects.toMatchObject({ reason: "precondition_drift" });
    await expect(readFile(entryPath)).resolves.toEqual(swapped);
    await expect(
      removeGovernedFileEntry(
        {
          rootPath: root,
          relativePath: "budgets.json",
          expectedParent: { volumeSerial: capture.parent.volumeSerial, fileId: capture.parent.fileId },
          expectedSha256: capture.sha256 as string,
        },
        { deadlineMs: 60_000 },
      ),
    ).rejects.toMatchObject({ reason: "precondition_drift" });
    await expect(readFile(entryPath)).resolves.toEqual(swapped);
  }, 180_000);

  it("refuses to follow a junction swapped into the parent chain mid-flight", async () => {
    const root = await scratch("goat-governed-port-junction-");
    await mkdir(join(root, "real"));
    const original = Buffer.from("legitimate-mirror-bytes");
    await writeFile(join(root, "real", "budgets.json"), original);
    const capture = await captureGovernedFileEntry(root, "real/budgets.json", { deadlineMs: 60_000 });
    expect(capture.present).toBe(true);

    // Mid-flight swap: the original parent moves away and a junction takes
    // its path. A path-based rename would traverse into the foreign target.
    await rename(join(root, "real"), join(root, "moved"));
    await symlink(join(root, "moved"), join(root, "real"), "junction");

    await expect(
      publishGovernedFileEntry(
        {
          rootPath: root,
          relativePath: "real/budgets.json",
          expectedParent: { volumeSerial: capture.parent.volumeSerial, fileId: capture.parent.fileId },
          expectedPrior: { present: true, sha256: capture.sha256 as string },
          content: Buffer.from("must-never-cross-a-reparse-point"),
        },
        { deadlineMs: 60_000 },
      ),
    ).rejects.toMatchObject({ reason: "reparse_refused" });
    await expect(captureGovernedFileEntry(root, "real/budgets.json", { deadlineMs: 60_000 })).rejects.toMatchObject({
      reason: "reparse_refused",
    });
    await expect(readFile(join(root, "moved", "budgets.json"))).resolves.toEqual(original);
  }, 180_000);

  it("refuses a reparse or directory entry at the target name instead of following it", async () => {
    const root = await scratch("goat-governed-port-entry-swap-");
    const target = Buffer.from("symlink-target-must-stay");
    await writeFile(join(root, "target.json"), target);
    let entrySymlinkCreated = true;
    try {
      await symlink(join(root, "target.json"), join(root, "budgets.json"), "file");
    } catch {
      // File symlinks need a privilege some runners lack; a directory
      // junction at the entry name still proves the same no-follow refusal.
      entrySymlinkCreated = false;
      await mkdir(join(root, "junction-target"));
      await symlink(join(root, "junction-target"), join(root, "budgets.json"), "junction");
    }
    await expect(captureGovernedFileEntry(root, "budgets.json", { deadlineMs: 60_000 })).rejects.toMatchObject({
      reason: entrySymlinkCreated ? "reparse_refused" : "entry_kind_invalid",
    });
    await expect(readFile(join(root, "target.json"))).resolves.toEqual(target);
  }, 180_000);

  it("refuses a parent directory identity swap even without any reparse point", async () => {
    const root = await scratch("goat-governed-port-parent-swap-");
    await mkdir(join(root, "real"));
    const original = Buffer.from("identity-bound-bytes");
    await writeFile(join(root, "real", "budgets.json"), original);
    const capture = await captureGovernedFileEntry(root, "real/budgets.json", { deadlineMs: 60_000 });

    await rename(join(root, "real"), join(root, "moved"));
    await mkdir(join(root, "real"));
    await writeFile(join(root, "real", "budgets.json"), original);

    await expect(
      publishGovernedFileEntry(
        {
          rootPath: root,
          relativePath: "real/budgets.json",
          expectedParent: { volumeSerial: capture.parent.volumeSerial, fileId: capture.parent.fileId },
          expectedPrior: { present: true, sha256: capture.sha256 as string },
          content: Buffer.from("must-not-land-in-the-impostor"),
        },
        { deadlineMs: 60_000 },
      ),
    ).rejects.toMatchObject({ reason: "parent_identity_changed" });
    await expect(readFile(join(root, "real", "budgets.json"))).resolves.toEqual(original);
    await expect(readFile(join(root, "moved", "budgets.json"))).resolves.toEqual(original);
  }, 180_000);

  it("refuses hard-linked entries whose replacement would silently strand aliases", async () => {
    const root = await scratch("goat-governed-port-hardlink-");
    const entryPath = join(root, "budgets.json");
    await writeFile(entryPath, Buffer.from("linked"));
    await link(entryPath, join(root, "alias.json"));
    await expect(captureGovernedFileEntry(root, "budgets.json", { deadlineMs: 60_000 })).rejects.toMatchObject({
      reason: "entry_kind_invalid",
    });
  }, 180_000);
});
