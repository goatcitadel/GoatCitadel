import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  ApprovalRequest,
  CapabilitySkillActionOutcome,
  CapabilitySkillItem,
  CapabilitySkillsResponse,
  SkillListItem,
  SkillRuntimeState,
} from "@goatcitadel/contracts";
import { buildApp } from "./app.js";
import { OPERATOR_SKILL_SKIP_NOTES } from "./services/capability-skill-actions-service.js";

/**
 * The Capabilities skill switch over the real Gateway, with the operator's "skip approvals" setting on, then off. The
 * unit tests fake every owner; these prove the switch reaches the real skill state owner, the Inbox's resolve and the
 * recovered approval effect: a skipped approval is still created, approved by the operator with its note, and applied
 * only by its effect. Each test switches its own shipped skill, so a wait left in the Inbox can't touch the next one.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKILLS_URL = "/api/v1/capabilities/skills";
const STATE_URL = "/api/v1/capabilities/skills/state";
const TOKEN = "capability-skill-actions-test-operator-1234567890";

const ENV: Record<string, string> = {
  GATEWAY_HOST: "127.0.0.1",
  NODE_ENV: "test",
  GOATCITADEL_ALLOWED_ORIGINS: "http://localhost:5173",
  GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS: "false",
  GOATCITADEL_AUTH_MODE: "token",
  GOATCITADEL_AUTH_TOKEN: TOKEN,
  GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS: "false",
  GOATCITADEL_BUNDLED_POSTGRES_AUTOSTART: "false",
  GOATCITADEL_BUNDLED_POSTGRES_ENABLED: "false",
  GOATCITADEL_DATABASE_DRIVER: "sqlite",
  GOATCITADEL_DISABLE_SECRET_STORE: "true",
  GOATCITADEL_LLAMACPP_AUTOSTART: "false",
  GOATCITADEL_LLAMACPP_ENABLED: "false",
  GOATCITADEL_NPU_AUTOSTART: "false",
  GOATCITADEL_NPU_ENABLED: "false",
  GOATCITADEL_RATE_LIMIT_ENABLED: "false",
  // The operator's "apply my changes without an Inbox approval" setting, on unless a test group turns it off.
  GOATCITADEL_FEATURE_SETTINGS_APPROVAL_SKIP_ENABLED: "true",
};

/** A Gateway on a temp root with the shipped bundled skills, booted with these environment overrides. */
function useGateway(extraEnv: Record<string, string> = {}) {
  const originalEnv = new Map<string, string | undefined>();
  const state = { root: "", app: undefined as FastifyInstance | undefined, sequence: 0 };

  beforeAll(async () => {
    state.root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-capability-skill-actions-"));
    writeConfig(path.join(state.root, "config"));
    fs.cpSync(path.join(REPO_ROOT, "skills", "bundled"), path.join(state.root, "skills", "bundled"), {
      recursive: true,
    });
    for (const [key, value] of Object.entries({ ...ENV, ...extraEnv, GOATCITADEL_ROOT_DIR: state.root })) {
      originalEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
    state.app = await buildApp();
    await state.app.ready();
  }, 300_000);

  afterAll(async () => {
    await state.app?.close();
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(state.root, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  });

  async function inject(method: "GET" | "POST" | "PATCH", url: string, payload?: Record<string, unknown>) {
    return await state.app!.inject({
      method,
      url,
      headers: { authorization: `Bearer ${TOKEN}`, "idempotency-key": `capability-skill-actions-${++state.sequence}` },
      ...(payload ? { payload } : {}),
    });
  }

  async function readSkill(skillId: string): Promise<CapabilitySkillItem> {
    const response = await inject("GET", `${SKILLS_URL}?workspaceId=default`);
    expect(response.statusCode, response.body).toBe(200);
    const skill = response.json<CapabilitySkillsResponse>().items.find((item) => item.skillId === skillId);
    expect(skill, skillId).toBeDefined();
    return skill!;
  }

  /** The skill's state as the skill list itself reports it. */
  async function readRuntimeState(skillId: string): Promise<SkillRuntimeState | undefined> {
    const response = await inject("GET", "/api/v1/skills");
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ items: SkillListItem[] }>().items.find((item) => item.skillId === skillId)?.state;
  }

  async function readApproval(approvalId: string): Promise<ApprovalRequest> {
    const response = await inject("GET", `/api/v1/approvals/${approvalId}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<ApprovalRequest>();
  }

  async function switchSkill(skillId: string, state: SkillRuntimeState, expectedRevision: number) {
    return await inject("POST", STATE_URL, { workspaceId: "default", skillId, state, expectedRevision });
  }

  /** The approvals audit stream's lines, as the Gateway wrote them. */
  function readApprovalAudit(): Array<Record<string, unknown>> {
    const config = state.app!.gatewayConfig;
    const file = path.join(path.resolve(config.rootDir, config.assistant.auditDir), "approvals.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  return { inject, readSkill, readRuntimeState, readApproval, switchSkill, readApprovalAudit };
}

describe("the Capabilities skill switch over the real Gateway, with the skip setting on", { timeout: 300_000 }, () => {
  const gateway = useGateway();

  it("switches a skill on at once when the setting is on", async () => {
    const skillId = "bundled:research";
    // Off first, so there is something to switch on; with the setting on, that applies at once too.
    const off = await gateway.switchSkill(skillId, "disabled", (await gateway.readSkill(skillId)).revision);
    expect(off.statusCode, off.body).toBe(202);
    expect(off.json<CapabilitySkillActionOutcome>()).toMatchObject({ status: "approved" });
    await vi.waitFor(async () => expect(await gateway.readRuntimeState(skillId)).toBe("disabled"), {
      timeout: 20_000,
      interval: 100,
    });

    const on = await gateway.switchSkill(skillId, "enabled", (await gateway.readSkill(skillId)).revision);

    expect(on.statusCode, on.body).toBe(202);
    const outcome = on.json<CapabilitySkillActionOutcome>();
    expect(outcome).toMatchObject({ status: "approved", approvalId: expect.any(String) });
    const approvalId = (outcome as { approvalId: string }).approvalId;
    // The approval's own effect applies the change.
    await vi.waitFor(async () => expect(await gateway.readRuntimeState(skillId)).toBe("enabled"), {
      timeout: 20_000,
      interval: 100,
    });
    // The skill's own approval was created, then approved by the operator who asked, with the note saying why.
    const approval = await gateway.readApproval(approvalId);
    expect(approval).toMatchObject({
      kind: "skill.lifecycle",
      status: "approved",
      resolutionNote: OPERATOR_SKILL_SKIP_NOTES.setting,
    });
    const requesterId = (approval.payload as { request?: { requesterId?: string } }).request?.requesterId;
    expect(requesterId).toEqual(expect.any(String));
    expect(approval.resolvedBy).toBe(requesterId);
    expect(gateway.readApprovalAudit()).toContainEqual(
      expect.objectContaining({
        event: "operator_approval_skipped",
        approvalId,
        kind: "skill.lifecycle",
        reason: "setting",
        actorId: requesterId,
      }),
    );
    const listed = await gateway.readSkill(skillId);
    expect(listed).toMatchObject({ state: "on", callable: true });
    expect(listed.pendingApprovalId).toBeUndefined();

    // Switching it to the state it is already in asks nothing.
    const again = await gateway.switchSkill(skillId, "enabled", listed.revision);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toEqual({ status: "unchanged" });
  });

  it("leaves the old Library route asking even with the setting on", async () => {
    const skillId = "bundled:planning";
    const before = await gateway.readSkill(skillId);

    const patched = await gateway.inject("PATCH", "/api/v1/skills/by-id/state", {
      skillId,
      state: "disabled",
      expectedRevision: before.revision,
    });

    expect(patched.statusCode, patched.body).toBe(202);
    const { pendingApproval } = patched.json<{ pendingApproval: { approvalId: string; status: string } }>();
    expect(pendingApproval.status).toBe("pending");
    expect((await gateway.readApproval(pendingApproval.approvalId)).status).toBe("pending");
    expect(await gateway.readRuntimeState(skillId)).toBe("enabled");
    // A reload while it waits still shows the wait.
    expect(await gateway.readSkill(skillId)).toMatchObject({
      state: "on",
      pendingApprovalId: pendingApproval.approvalId,
    });
    expect(gateway.readApprovalAudit()).not.toContainEqual(
      expect.objectContaining({ approvalId: pendingApproval.approvalId }),
    );
  });
});

describe("the Capabilities skill switch over the real Gateway, with the skip setting off", { timeout: 300_000 }, () => {
  const gateway = useGateway({ GOATCITADEL_FEATURE_SETTINGS_APPROVAL_SKIP_ENABLED: "false" });

  it("pauses a skill that is on at once, since that only takes power away", async () => {
    const skillId = "bundled:operations";

    const paused = await gateway.switchSkill(skillId, "sleep", (await gateway.readSkill(skillId)).revision);

    expect(paused.statusCode, paused.body).toBe(202);
    const outcome = paused.json<CapabilitySkillActionOutcome>();
    expect(outcome).toMatchObject({ status: "approved", approvalId: expect.any(String) });
    const approvalId = (outcome as { approvalId: string }).approvalId;
    await vi.waitFor(async () => expect(await gateway.readRuntimeState(skillId)).toBe("sleep"), {
      timeout: 20_000,
      interval: 100,
    });
    expect(await gateway.readApproval(approvalId)).toMatchObject({
      status: "approved",
      resolutionNote: OPERATOR_SKILL_SKIP_NOTES.tightening,
      preview: { currentState: "enabled", state: "sleep" },
    });
    expect(gateway.readApprovalAudit()).toContainEqual(
      expect.objectContaining({ event: "operator_approval_skipped", approvalId, reason: "tightening" }),
    );
  });

  it("keeps asking to pause a skill that is off, since a paused skill can be used again", async () => {
    const skillId = "bundled:documentation";
    // Off first: turning a skill off only takes power away, so that applies at once.
    const off = await gateway.switchSkill(skillId, "disabled", (await gateway.readSkill(skillId)).revision);
    expect(off.statusCode, off.body).toBe(202);
    expect(off.json<CapabilitySkillActionOutcome>()).toMatchObject({ status: "approved" });
    await vi.waitFor(async () => expect(await gateway.readRuntimeState(skillId)).toBe("disabled"), {
      timeout: 20_000,
      interval: 100,
    });

    const paused = await gateway.switchSkill(skillId, "sleep", (await gateway.readSkill(skillId)).revision);

    expect(paused.statusCode, paused.body).toBe(202);
    const outcome = paused.json<CapabilitySkillActionOutcome>();
    expect(outcome).toMatchObject({ status: "waiting", approvalId: expect.any(String) });
    const approvalId = (outcome as { approvalId: string }).approvalId;
    expect(await gateway.readApproval(approvalId)).toMatchObject({
      status: "pending",
      preview: { currentState: "disabled", state: "sleep" },
    });
    expect(await gateway.readRuntimeState(skillId)).toBe("disabled");
    expect(await gateway.readSkill(skillId)).toMatchObject({ state: "off", pendingApprovalId: approvalId });
    expect(gateway.readApprovalAudit()).not.toContainEqual(expect.objectContaining({ approvalId }));
  });
});

describe("the Capabilities skill switch over a real remote_hardened Gateway", { timeout: 300_000 }, () => {
  const gateway = useGateway({
    GOATCITADEL_DEPLOYMENT_PROFILE: "remote_hardened",
    GOATCITADEL_ALLOWED_ORIGINS: "https://ops.example.com",
  });

  it("always asks under remote_hardened, even to switch off", async () => {
    const skillId = "bundled:qa";
    const before = await gateway.readSkill(skillId);

    const off = await gateway.switchSkill(skillId, "disabled", before.revision);

    expect(off.statusCode, off.body).toBe(202);
    const outcome = off.json<CapabilitySkillActionOutcome>();
    expect(outcome).toMatchObject({ status: "waiting", approvalId: expect.any(String) });
    const approvalId = (outcome as { approvalId: string }).approvalId;
    expect((await gateway.readApproval(approvalId)).status).toBe("pending");
    expect(await gateway.readRuntimeState(skillId)).toBe("enabled");
    expect(await gateway.readSkill(skillId)).toMatchObject({ state: "on", pendingApprovalId: approvalId });
    expect(gateway.readApprovalAudit()).not.toContainEqual(expect.objectContaining({ approvalId }));

    // The operator turns it down in the Inbox. The same click again hands back that decided approval: it says so.
    const rejected = await gateway.inject("POST", `/api/v1/approvals/${approvalId}/resolve`, { decision: "reject" });
    expect(rejected.statusCode, rejected.body).toBe(200);
    const again = await gateway.switchSkill(skillId, "disabled", before.revision);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toEqual({ status: "declined", approvalId, expired: false });
    expect(await gateway.readRuntimeState(skillId)).toBe("enabled");
    expect((await gateway.readSkill(skillId)).pendingApprovalId).toBeUndefined();
  });
});

/** Only the checked-in examples; never an operator's own config. */
function writeConfig(configDir: string): void {
  fs.mkdirSync(configDir, { recursive: true });
  const repoConfig = path.join(REPO_ROOT, "config");
  for (const name of [
    "assistant.config.example.json",
    "tool-policy.example.json",
    "budgets.example.json",
    "cron-jobs.example.json",
  ]) {
    fs.copyFileSync(path.join(repoConfig, name), path.join(configDir, name));
  }
  const config = JSON.parse(fs.readFileSync(path.join(repoConfig, "goatcitadel.example.json"), "utf8"));
  // An approval never asks a model to explain it here.
  config.assistant.approvalExplainer.enabled = false;
  fs.writeFileSync(path.join(configDir, "goatcitadel.json"), JSON.stringify(config));
  fs.writeFileSync(path.join(configDir, "llm-model-metadata.json"), JSON.stringify({ version: 1, entries: {} }));
}
