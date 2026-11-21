import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import { GoogleWorkspaceReviewService, type GoogleReviewDependencies } from "./google-workspace-review-service.js";

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
function setup(root = process.cwd()) {
  const blobs = new Map<string, Uint8Array>();
  const get = vi.fn();
  const service = new GoogleWorkspaceReviewService({
    dataRoot: root,
    storage: {
      chatSessionMeta: { get: async () => ({ workspaceId: "w" }) },
      chatToolRuns: { get },
    } as unknown as GoogleReviewDependencies["storage"],
    sandbox: () =>
      ({
        writeJailRoots: [root],
        readOnlyRoots: [],
        networkAllowlist: [],
        riskyShellPatterns: [],
        requireApprovalForRiskyShell: true,
      }) as ToolPolicyConfig["sandbox"],
    snapshotStore: {
      publish: async ({ bytes, expectedSha256 }) => {
        blobs.set(expectedSha256, bytes);
        return { artifactRelPath: expectedSha256, artifactSha256: expectedSha256 } as never;
      },
      read: async ({ artifactRelPath, expectedSha256 }) => {
        const bytes = blobs.get(artifactRelPath)!;
        if (!bytes || digest(bytes) !== expectedSha256) throw new Error("tampered");
        return { bytes } as never;
      },
    },
  });
  const request: ToolInvokeRequest = {
    toolName: "gmail.send",
    agentId: "assistant",
    sessionId: "s",
    workspaceId: "w",
    googleReadSignInId: "sign1",
    args: { connectionId: "g", to: ["a@example.com"], subject: "Hi", bodyText: "reviewed body" },
  };
  return { service, request, get, blobs };
}
describe("Google immutable review owner", () => {
  it("freezes MIME across replay and rejects changed material or account/session/sign-in", async () => {
    const { service, request } = setup();
    const reviewed = await service.normalize(request);
    const first = await service.resolvePreparedMail(reviewed);
    const replay = await service.normalize(reviewed);
    expect(await service.resolvePreparedMail(replay)).toEqual(first);
    await expect(
      service.normalize({ ...reviewed, args: { ...reviewed.args, bodyText: "substituted" } }),
    ).rejects.toThrow(/changed/);
    for (const changes of [
      { sessionId: "other" },
      { googleReadSignInId: "sign2" },
      { args: { ...reviewed.args, connectionId: "other" } },
    ]) {
      await expect(service.normalize({ ...reviewed, ...changes })).rejects.toThrow(/another Chat/);
    }
    const forgedSummary = await service.normalize({
      ...reviewed,
      args: { ...reviewed.args, _googleSourceSummary: "fake" },
    });
    expect(forgedSummary.args._googleSourceSummary).toBeUndefined();
  });
  it("requires a canonical successful source read from the same Chat", async () => {
    const { service, request, get } = setup();
    get.mockResolvedValue({
      status: "executed",
      sessionId: "other",
      toolName: "gmail.get_message",
      args: { connectionId: "g" },
    });
    await expect(
      service.normalize({
        ...request,
        toolName: "gmail.reply",
        args: { connectionId: "g", sourceToolRunId: "r", bodyText: "reply" },
      }),
    ).rejects.toThrow(/this Chat/);
  });
  it("refuses changed file bytes and paths outside governed roots", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-google-files-"));
    roots.push(root);
    const { service, request } = setup(root);
    const files = service.filePort(request);
    const ref = await files.write({
      bytes: Buffer.from("approved"),
      filename: "report.txt",
      contentType: "text/plain",
    });
    expect(Buffer.from(await files.read(ref)).toString()).toBe("approved");
    await fs.writeFile(ref.path, "replaced");
    await expect(files.read(ref)).rejects.toThrow(/changed/);
    await expect(files.read({ ...ref, path: path.resolve(root, "..", "outside.txt") })).rejects.toThrow();
  });
  it("rejects misspelled or malformed Calendar changes before review", async () => {
    const { service, request } = setup();
    await expect(
      service.normalize({
        ...request,
        toolName: "calendar.update_event",
        args: { connectionId: "g", eventId: "e", eventEtag: "v", titlle: "lost edit" },
      }),
    ).rejects.toThrow(/Invalid Google argument/);
  });
});
