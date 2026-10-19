import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolInvokeRequest } from "@goatcitadel/contracts";
import { readOutsideRootWriteApprovalDetails } from "@goatcitadel/contracts";
import { executeTool } from "./tool-executor.js";
import {
  createOutsideRootFixture,
  createOutsideRootStorage,
  outsideRootConfig,
  type OutsideRootFixture,
} from "./outside-root-write.test-support.js";

let fixture: OutsideRootFixture;

beforeEach(() => {
  fixture = createOutsideRootFixture();
});

afterEach(() => {
  fixture.cleanup();
});

const hooks = { resolveOutsideRootWriteEligibility: async () => true };

function writeRequest(target: string, extra: Partial<ToolInvokeRequest> = {}): ToolInvokeRequest {
  return { toolName: "fs.write", args: { path: target, content: "hello" }, agentId: "agent", sessionId: "session-1", ...extra };
}

async function folderGrant(fake: ReturnType<typeof createOutsideRootStorage>, scope: "session" | "workspace", scopeRef: string) {
  return await fake.storage.toolGrants.createTtlForDuration(
    { toolPattern: "fs.write", decision: "allow", scope, scopeRef, createdBy: "operator", constraints: { writeRoots: [fixture.outside] } },
    60 * 60_000,
  );
}

describe("executeTool outside-root write admission", () => {
  it("writes inside a folder grant scoped to this session", async () => {
    const fake = createOutsideRootStorage();
    const grant = await folderGrant(fake, "session", "session-1");
    const target = path.join(fixture.outside, "report.txt");
    await executeTool(
      writeRequest(target, { policyContext: { matchedGrantId: grant.grantId } }),
      outsideRootConfig(fixture),
      fake.storage,
      hooks,
    );
    expect(fs.readFileSync(target, "utf8")).toBe("hello");
  });

  it("refuses a folder grant scoped to another session", async () => {
    const fake = createOutsideRootStorage();
    const grant = await folderGrant(fake, "session", "session-other");
    const target = path.join(fixture.outside, "report.txt");
    await expect(
      executeTool(writeRequest(target, { policyContext: { matchedGrantId: grant.grantId } }), outsideRootConfig(fixture), fake.storage, hooks),
    ).rejects.toThrow(/outside write jail/iu);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("refuses forged, revoked, and ineligible requests", async () => {
    const fake = createOutsideRootStorage();
    const grant = await folderGrant(fake, "session", "session-1");
    const target = path.join(fixture.outside, "report.txt");
    const config = outsideRootConfig(fixture);
    await expect(
      executeTool(writeRequest(target, { policyContext: { matchedGrantId: "grant-forged" } }), config, fake.storage, hooks),
    ).rejects.toThrow(/outside write jail/iu);
    await expect(
      executeTool(writeRequest(target, { policyContext: { matchedGrantId: grant.grantId } }), config, fake.storage, {}),
    ).rejects.toThrow(/outside write jail/iu);
    await fake.storage.toolGrants.revoke(grant.grantId, undefined, "operator");
    await expect(
      executeTool(writeRequest(target, { policyContext: { matchedGrantId: grant.grantId } }), config, fake.storage, hooks),
    ).rejects.toThrow(/outside write jail/iu);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("writes the exact approve-once target and refuses a different one", async () => {
    const fake = createOutsideRootStorage();
    const target = path.join(fixture.outside, "approved.txt");
    const request = writeRequest(target);
    const registration = {
      outsideRootWrite: readOutsideRootWriteApprovalDetails({
        kind: "outside_root_write",
        targets: [target],
        candidates: [],
        durations: ["1h"],
        defaultDuration: "1h",
      }),
    };
    fake.seedApproval({ approvalId: "approval-once", request: { ...request }, registration });
    const consent = { consentContext: { source: "ui", reason: "approval:approval-once" } } as Partial<ToolInvokeRequest>;
    await executeTool({ ...request, ...consent }, outsideRootConfig(fixture), fake.storage, hooks);
    expect(fs.readFileSync(target, "utf8")).toBe("hello");

    const other = path.join(fixture.outside, "other.txt");
    await expect(
      executeTool({ ...writeRequest(other), ...consent }, outsideRootConfig(fixture), fake.storage, hooks),
    ).rejects.toThrow(/outside write jail/iu);
    expect(fs.existsSync(other)).toBe(false);
  });

  it("refuses everything when the mode is deny", async () => {
    const fake = createOutsideRootStorage();
    const grant = await folderGrant(fake, "session", "session-1");
    const target = path.join(fixture.outside, "report.txt");
    await expect(
      executeTool(
        writeRequest(target, { policyContext: { matchedGrantId: grant.grantId } }),
        outsideRootConfig(fixture, { mode: "deny" }),
        fake.storage,
        hooks,
      ),
    ).rejects.toThrow(/outside write jail/iu);
  });
});
