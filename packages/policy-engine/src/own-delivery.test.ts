import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import { Storage, createSqliteAsyncStorage, type AsyncStorage } from "@goatcitadel/storage";
import { ToolPolicyEngine } from "./engine.js";
import {
  createOwnDeliveryMarker,
  isOwnDeliveryMarker,
  type OwnDeliveryMarker,
  type OwnDeliveryReason,
} from "./own-delivery.js";

const SWITCHED_OFF_PHRASE = "tool group switched off";

function config(writeJailRoot = "."): ToolPolicyConfig {
  return {
    tools: { approvalMode: "bypass", allow: ["git.status", "fs.write"], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: [writeJailRoot],
      readOnlyRoots: [],
      networkAllowlist: [],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
}

function request(toolName: string, args: Record<string, unknown> = {}): ToolInvokeRequest {
  return { toolName, args, agentId: "operator", sessionId: "own-delivery-session", workspaceId: "default" };
}

describe("own-delivery marker", () => {
  it("counts only markers it minted", () => {
    const marker = createOwnDeliveryMarker("channel_reply");
    expect(isOwnDeliveryMarker(marker)).toBe(true);
    expect(marker).toEqual({ kind: "own_delivery", reason: "channel_reply" });
    expect(Object.isFrozen(marker)).toBe(true);

    expect(isOwnDeliveryMarker({ kind: "own_delivery", reason: "channel_reply" })).toBe(false);
    expect(isOwnDeliveryMarker({ ...marker })).toBe(false);
    expect(isOwnDeliveryMarker(JSON.parse(JSON.stringify(marker)))).toBe(false);
    expect(isOwnDeliveryMarker(structuredClone(marker))).toBe(false);
    for (const value of [undefined, null, true, "own_delivery", 1]) {
      expect(isOwnDeliveryMarker(value)).toBe(false);
    }
  });

  it("refuses an unknown reason", () => {
    expect(() => createOwnDeliveryMarker("ai_action" as OwnDeliveryReason)).toThrow("Invalid own-delivery reason");
  });
});

describe("own delivery in the policy engine", () => {
  let root: string;
  let storage: Storage;
  let asyncStorage: AsyncStorage;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-own-delivery-"));
    storage = new Storage({
      dbPath: path.join(root, "runtime.db"),
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    asyncStorage = createSqliteAsyncStorage(storage);
  }, 30_000);
  afterEach(async () => {
    await asyncStorage?.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("lets a minted own-delivery marker past a switched-off group and nothing else", async () => {
    const policy = config();
    policy.tools.disabledGroups = ["git"];
    const engine = new ToolPolicyEngine(policy, asyncStorage);
    const ownDelivery = createOwnDeliveryMarker("operator_action");

    // A minted marker is allowed past the switch, through inspection and a real invoke.
    const minted = await engine.inspectAccess(request("git.status"), { ownDelivery });
    expect(minted.allowed).toBe(true);
    expect(minted.reasonCodes).not.toContain("tool_group_off");
    expect((await engine.invoke(request("git.status"), { ownDelivery })).outcome).not.toBe("blocked");

    // A look-alike object is not a marker: the switch still applies.
    const lookAlike = { kind: "own_delivery", reason: "channel_reply" } as unknown as OwnDeliveryMarker;
    const copied = await engine.inspectAccess(request("git.status"), { ownDelivery: lookAlike });
    expect(copied.allowed).toBe(false);
    expect(copied.reasonCodes).toEqual(["tool_group_off"]);
    const blocked = await engine.invoke(request("git.status"), { ownDelivery: lookAlike });
    expect(blocked.outcome).toBe("blocked");
    expect(blocked.policyReason).toContain(SWITCHED_OFF_PHRASE);

    // Deny-wins is untouched: a minted marker never lifts a tools.deny entry.
    policy.tools.deny = ["git.status"];
    const denied = await engine.inspectAccess(request("git.status"), { ownDelivery });
    expect(denied.allowed).toBe(false);
    expect(denied.reasonCodes).toEqual(["policy_deny"]);
    expect((await engine.invoke(request("git.status"), { ownDelivery })).policyReason).toContain(
      "tool denied by policy",
    );
  });

  it("carries the marker into an approval the caller already holds", async () => {
    const workDir = path.join(root, "work");
    await fs.mkdir(workDir, { recursive: true });
    const policy = config(workDir);
    policy.tools.approvalMode = "approve_risky";
    const engine = new ToolPolicyEngine(policy, asyncStorage);

    // The operator's approved send presents its approval on the same invoke, the way the Communications path does.
    const approvedInvoke = async (file: string, options: { ownDelivery?: OwnDeliveryMarker }) => {
      const write = request("fs.write", { path: path.join(workDir, file), content: "hello" });
      const asked = await engine.invoke(write);
      expect(asked.outcome).toBe("approval_required");
      await asyncStorage.approvals.resolve(asked.approvalId!, { decision: "approve", resolvedBy: "operator" });
      policy.tools.disabledGroups = ["files"];
      const result = await engine.invoke(
        { ...write, consentContext: { source: "ui", reason: `approval:${asked.approvalId}` } },
        options,
      );
      policy.tools.disabledGroups = [];
      return result;
    };

    const withMarker = await approvedInvoke("own.txt", { ownDelivery: createOwnDeliveryMarker("operator_action") });
    expect(withMarker.outcome).toBe("executed");
    await expect(fs.readFile(path.join(workDir, "own.txt"), "utf8")).resolves.toBe("hello");

    const withoutMarker = await approvedInvoke("ai.txt", {});
    expect(withoutMarker.outcome).toBe("blocked");
    expect(withoutMarker.policyReason).toContain(SWITCHED_OFF_PHRASE);
    await expect(fs.stat(path.join(workDir, "ai.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
