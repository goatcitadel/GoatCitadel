import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExternalSourceWindowsSecurityError,
  NodeExternalSourceWindowsSecurity,
  type ExternalSourceWindowsSecurityProtocol,
} from "./external-source-windows-security.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const temporaryWorkspaceMarkers: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  await Promise.all(temporaryWorkspaceMarkers.splice(0).map((marker) => fs.rm(marker, { force: true })));
});

describe("NodeExternalSourceWindowsSecurity", () => {
  it("uses a narrow protocol and detects the complete Windows reparse attribute", async () => {
    const protocol = new RecordingProtocol();
    const security = new NodeExternalSourceWindowsSecurity(protocol);
    const absolutePath = path.resolve("fixture &; $(never-executed)");

    protocol.response = "1024";
    await expect(security.inspectReparsePoint(absolutePath, freshSignal())).resolves.toBe(true);
    protocol.response = "32";
    await expect(security.inspectReparsePoint(absolutePath, freshSignal())).resolves.toBe(false);
    expect(protocol.requests).toEqual([
      ["attributes", absolutePath, "file"],
      ["attributes", absolutePath, "file"],
    ]);
  });

  it("fails closed on command errors and malformed or adversarial responses", async () => {
    const protocol = new RecordingProtocol();
    const security = new NodeExternalSourceWindowsSecurity(protocol);
    const absolutePath = path.resolve("fixture");

    for (const response of ["-1", "1024\n1|OK|0", "9007199254740992", "not-a-number"]) {
      protocol.response = response;
      await expectCode(security.inspectReparsePoint(absolutePath, freshSignal()), "invalid_response");
    }
    protocol.error = new Error("synthetic runner failure containing a secret path");
    await expectCode(security.inspectReparsePoint(absolutePath, freshSignal()), "command_failed");
  });

  it("requires a verified owner SID and honors cancellation", async () => {
    const protocol = new RecordingProtocol();
    const security = new NodeExternalSourceWindowsSecurity(protocol);
    const absolutePath = path.resolve("fixture");

    protocol.response = "S-1-5-21-1-2-3-1001";
    await expect(security.applyOwnerOnlyAcl(absolutePath, "file", freshSignal())).resolves.toEqual({
      ownerSid: protocol.response,
    });
    protocol.response = "BUILTIN\\Users";
    await expectCode(security.applyOwnerOnlyAcl(absolutePath, "file", freshSignal()), "invalid_response");

    const controller = new AbortController();
    controller.abort();
    await expectCode(security.inspectReparsePoint(absolutePath, controller.signal), "cancelled");
  });

  it("applies and independently proves an exact owner-only ACL on Windows", async () => {
    if (process.platform !== "win32") return;
    const root = await temporaryRoot();
    const markerName = `gc-acl-marker-${crypto.randomUUID()}`;
    const markerPath = path.join(process.cwd(), markerName);
    temporaryWorkspaceMarkers.push(markerPath);
    const directory = path.join(root, `strange &; $(New-Item ${markerName}) directory`);
    const file = path.join(directory, "artifact [x] '$safe'.bin");
    await fs.mkdir(directory);
    await fs.writeFile(file, "immutable fixture");
    await runIcacls([directory, "/grant", "*S-1-1-0:(OI)(CI)F", "/q", "/l"]);
    await runIcacls([file, "/grant", "*S-1-1-0:F", "/q", "/l"]);

    const security = new NodeExternalSourceWindowsSecurity();
    const directoryResult = await security.applyOwnerOnlyAcl(directory, "directory", freshSignal());
    const fileResult = await security.applyOwnerOnlyAcl(file, "file", freshSignal());

    expect(fileResult.ownerSid).toBe(directoryResult.ownerSid);
    expect(await readSavedDacl(directory)).toEqual({
      ownerSid: directoryResult.ownerSid,
      inheritanceFlags: ["CI", "OI"],
    });
    expect(await readSavedDacl(file)).toEqual({
      ownerSid: directoryResult.ownerSid,
      inheritanceFlags: [],
    });
    await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("isolates a replacement worker from late events after cancellation", async () => {
    if (process.platform !== "win32") return;
    const root = await temporaryRoot();
    const file = path.join(root, "worker-replacement-fixture.txt");
    await fs.writeFile(file, "fixture");
    const security = new NodeExternalSourceWindowsSecurity();
    const controller = new AbortController();

    const cancelled = security.inspectReparsePoint(file, controller.signal);
    controller.abort();
    await expectCode(cancelled, "cancelled");

    await expect(security.inspectReparsePoint(file, freshSignal())).resolves.toBe(false);
  });
});

class RecordingProtocol implements ExternalSourceWindowsSecurityProtocol {
  public response = "0";
  public error: Error | undefined;
  public readonly requests: Array<[string, string, string]> = [];

  public async request(
    operation: "acl" | "attributes",
    absolutePath: string,
    kind: "directory" | "file",
  ): Promise<string> {
    this.requests.push([operation, absolutePath, kind]);
    if (this.error) throw this.error;
    return this.response;
  }
}

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-windows-security-"));
  temporaryRoots.push(root);
  return root;
}

async function runIcacls(args: readonly string[]): Promise<void> {
  await execFileAsync("icacls.exe", [...args], {
    shell: false,
    windowsHide: true,
  });
}

async function readSavedDacl(absolutePath: string): Promise<{
  ownerSid: string;
  inheritanceFlags: string[];
}> {
  const aclFile = path.join(os.tmpdir(), `gc-acl-${crypto.randomUUID()}.txt`);
  temporaryRoots.push(aclFile);
  await runIcacls([absolutePath, "/save", aclFile, "/q", "/l"]);
  const saved = await fs.readFile(aclFile, "utf16le");
  const descriptorOffset = saved.indexOf("D:");
  expect(descriptorOffset).toBeGreaterThanOrEqual(0);
  const descriptor = saved.slice(descriptorOffset).trim();
  expect(descriptor).toMatch(/^D:P/u);
  expect(descriptor).not.toContain("S-1-1-0");
  expect(descriptor).not.toContain("S-1-5-32-545");
  const accessEntries = descriptor.match(/\([^()]+\)/gu) ?? [];
  expect(accessEntries).toHaveLength(1);
  const fields = accessEntries[0]?.slice(1, -1).split(";") ?? [];
  expect(fields[0]).toBe("A");
  expect(fields[2]).toBe("FA");
  expect(fields[3]).toBe("");
  expect(fields[4]).toBe("");
  expect(fields[5]).toMatch(/^S-\d+(?:-\d+)+$/u);
  const flags = fields[1]?.match(/.{2}/gu)?.sort() ?? [];
  expect(flags.every((flag) => flag === "CI" || flag === "OI")).toBe(true);
  return { ownerSid: fields[5] ?? "", inheritanceFlags: flags };
}

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

async function expectCode(promise: Promise<unknown>, code: ExternalSourceWindowsSecurityError["code"]): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected Windows security error ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(ExternalSourceWindowsSecurityError);
    expect((error as ExternalSourceWindowsSecurityError).code).toBe(code);
    expect((error as Error).message).not.toMatch(/secret path|fixture/u);
  }
}
