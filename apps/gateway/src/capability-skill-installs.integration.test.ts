import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  ApprovalRequest,
  CapabilitySkillActionOutcome,
  CapabilitySkillInstall,
  CapabilitySkillInstallsResponse,
  CapabilitySkillItem,
  CapabilitySkillsResponse,
} from "@goatcitadel/contracts";
import { buildApp } from "./app.js";
import { OPERATOR_SKILL_SKIP_NOTES } from "./services/capability-skill-actions-service.js";

/**
 * Checking and installing a shipped skill pack from Capabilities over the real Gateway, with the operator's "skip
 * approvals" setting on, then off. The unit tests fake every owner; these prove the steps reach Skill Hub's real review,
 * its approval owner, the Inbox's resolve and the recovered approval effects: each step's approval is still created,
 * approved by the operator (or by the skip, with its note), and applied only by its effect, and the skill can't be used
 * before switching it on settles. On Windows the artifact store sets owner-only ACLs through PowerShell, so every wait
 * here is generous.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKILLS_URL = "/api/v1/capabilities/skills";
const REVIEWS_URL = "/api/v1/capabilities/skills/reviews";
const INSTALLS_URL = "/api/v1/capabilities/skills/installs";
const OPERATIONS_URL = "/api/v1/capabilities/skills/operations";
const TOKEN = "capability-skill-installs-test-operator-1234567890";
const WORKSPACE_ID = "default";
const STEP_WAIT = { timeout: 120_000, interval: 250 } as const;

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
  // The operator's "apply my changes without asking first" setting, on unless a test group turns it off.
  GOATCITADEL_FEATURE_SETTINGS_APPROVAL_SKIP_ENABLED: "true",
};

/** A Gateway on a temp root with the shipped bundled skills and skill packs, booted with these environment overrides. */
function useGateway(extraEnv: Record<string, string> = {}) {
  const originalEnv = new Map<string, string | undefined>();
  const state = { root: "", app: undefined as FastifyInstance | undefined, sequence: 0 };

  beforeAll(async () => {
    state.root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-capability-skill-installs-"));
    writeConfig(path.join(state.root, "config"));
    for (const folder of ["bundled", "import-packs"]) {
      fs.cpSync(path.join(REPO_ROOT, "skills", folder), path.join(state.root, "skills", folder), { recursive: true });
    }
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

  async function inject(method: "GET" | "POST", url: string, payload?: Record<string, unknown>) {
    return await state.app!.inject({
      method,
      url,
      headers: { authorization: `Bearer ${TOKEN}`, "idempotency-key": `capability-skill-installs-${++state.sequence}` },
      ...(payload ? { payload } : {}),
    });
  }

  async function checkPack(packId: string, idempotencyKey: string): Promise<CapabilitySkillInstall> {
    const response = await inject("POST", REVIEWS_URL, {
      workspaceId: WORKSPACE_ID,
      source: { kind: "pack", packId },
      idempotencyKey,
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<CapabilitySkillInstall>();
  }

  async function requestStep(snapshotId: string, operationKind: "install_inactive" | "activate") {
    const response = await inject("POST", OPERATIONS_URL, { workspaceId: WORKSPACE_ID, snapshotId, operationKind });
    expect(response.statusCode, response.body).toBe(202);
    return response.json<CapabilitySkillActionOutcome>() as { status: "approved" | "waiting"; approvalId: string };
  }

  async function readInstalls(): Promise<CapabilitySkillInstallsResponse> {
    const response = await inject("GET", `${INSTALLS_URL}?workspaceId=${WORKSPACE_ID}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<CapabilitySkillInstallsResponse>();
  }

  async function readInstall(snapshotId: string): Promise<CapabilitySkillInstall | undefined> {
    return (await readInstalls()).installs.find((install) => install.snapshotId === snapshotId);
  }

  /** One check at whatever step it is on, done included (R55). */
  async function readCheck(snapshotId: string): Promise<CapabilitySkillInstall | undefined> {
    const response = await inject("GET", `${INSTALLS_URL}?workspaceId=${WORKSPACE_ID}&snapshotId=${snapshotId}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<CapabilitySkillInstallsResponse>().installs[0];
  }

  /** Switching on settles, then the skill list reloads: wait for the install to read done, then for the skill. */
  async function waitUntilSwitchedOn(snapshotId: string, skillId: string): Promise<CapabilitySkillItem> {
    await vi.waitFor(async () => expect((await readCheck(snapshotId))?.step).toBe("done"), STEP_WAIT);
    expect(await readInstall(snapshotId)).toBeUndefined();
    await vi.waitFor(async () => expect((await readSkill(skillId))?.callable).toBe(true), STEP_WAIT);
    return (await readSkill(skillId))!;
  }

  /** The skill as the Installed list shows it, if it is installed. */
  async function readSkill(skillId: string): Promise<CapabilitySkillItem | undefined> {
    const response = await inject("GET", `${SKILLS_URL}?workspaceId=${WORKSPACE_ID}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<CapabilitySkillsResponse>().items.find((item) => item.skillId === skillId);
  }

  async function readApproval(approvalId: string): Promise<ApprovalRequest> {
    const response = await inject("GET", `/api/v1/approvals/${approvalId}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<ApprovalRequest>();
  }

  async function approve(approvalId: string): Promise<void> {
    const response = await inject("POST", `/api/v1/approvals/${approvalId}/resolve`, { decision: "approve" });
    expect(response.statusCode, response.body).toBe(200);
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

  return {
    inject,
    checkPack,
    requestStep,
    readInstalls,
    readInstall,
    readCheck,
    waitUntilSwitchedOn,
    readSkill,
    readApproval,
    approve,
    readApprovalAudit,
    root: () => state.root,
  };
}

describe(
  "installing a skill from Capabilities over the real Gateway, with the skip setting on",
  { timeout: 600_000 },
  () => {
    const gateway = useGateway();

    it("installs and switches on a pack at once when the setting is on", async () => {
      const checked = await gateway.checkPack("himalaya", "check-himalaya");
      expect(checked).toMatchObject({
        name: "Email over IMAP/SMTP (Himalaya)",
        source: { kind: "pack", packId: "himalaya" },
        step: "check_passed",
        blockers: [],
      });
      // No server path ever leaves the Gateway.
      expect(JSON.stringify(checked)).not.toContain(gateway.root());
      expect(JSON.stringify(checked)).not.toContain("import-packs");
      expect(await gateway.readSkill("extra:himalaya")).toBeUndefined();
      // A check that passed is not an install in progress.
      expect(await gateway.readInstall(checked.snapshotId)).toBeUndefined();

      const install = await gateway.requestStep(checked.snapshotId, "install_inactive");

      expect(install.status).toBe("approved");
      // Skill Hub's own approval was created, then approved by the operator who asked, with the note saying why.
      const installApproval = await gateway.readApproval(install.approvalId);
      expect(installApproval).toMatchObject({
        kind: "skill_hub.lifecycle",
        status: "approved",
        resolutionNote: OPERATOR_SKILL_SKIP_NOTES.setting,
      });
      expect(gateway.readApprovalAudit()).toContainEqual(
        expect.objectContaining({
          event: "operator_approval_skipped",
          approvalId: install.approvalId,
          kind: "skill_hub.lifecycle",
          reason: "setting",
          actorId: installApproval.resolvedBy,
        }),
      );
      // Only the approval's own effect installs it, and an installed skill isn't switched on.
      await vi.waitFor(
        async () => expect((await gateway.readInstall(checked.snapshotId))?.step).toBe("installed_off"),
        STEP_WAIT,
      );
      expect((await gateway.readSkill("extra:himalaya"))?.callable ?? false).toBe(false);

      const activate = await gateway.requestStep(checked.snapshotId, "activate");

      expect(activate.status).toBe("approved");
      expect(await gateway.readApproval(activate.approvalId)).toMatchObject({
        kind: "skill_hub.lifecycle",
        status: "approved",
        resolutionNote: OPERATOR_SKILL_SKIP_NOTES.setting,
      });
      // Once switching on settles, the install is done and leaves the in-progress list; only then can the AI use it.
      const installed = await gateway.waitUntilSwitchedOn(checked.snapshotId, "extra:himalaya");
      expect(await gateway.readCheck(checked.snapshotId)).toMatchObject({
        step: "done",
        installedSkillId: "extra:himalaya",
      });
      // GoatCitadel's own pack reads as built in, even installed through Skill Hub (R13, R43).
      expect(installed).toMatchObject({
        state: "on",
        callable: true,
        origin: "built_in",
        category: "email",
      });

      // Checking the same pack again finds it already installed.
      const again = await gateway.checkPack("himalaya", "check-himalaya-again");
      expect(again.step).toBe("blocked");
      expect(again.blockers).toContain("SOURCE_ALREADY_INSTALLED");
    });

    it("leaves the old Hub operations route asking even with the setting on", async () => {
      const checked = await gateway.checkPack("github-cli", "check-github-cli");
      expect(checked.step).toBe("check_passed");

      const response = await gateway.inject("POST", "/api/v1/skills/hub/operations", {
        workspaceId: WORKSPACE_ID,
        snapshotId: checked.snapshotId,
        operationKind: "install_inactive",
      });

      expect(response.statusCode, response.body).toBe(201);
      const { approval } = response.json<{ approval: { approvalId: string; status: string } }>();
      expect(approval.status).toBe("pending");
      const stored = await gateway.readApproval(approval.approvalId);
      expect(stored.status).toBe("pending");
      expect(gateway.readApprovalAudit()).not.toContainEqual(
        expect.objectContaining({ event: "operator_approval_skipped", approvalId: approval.approvalId }),
      );
      // A reload finds the install where it was left: waiting for its approval.
      expect(await gateway.readInstall(checked.snapshotId)).toMatchObject({
        step: "waiting_install",
        approvalId: approval.approvalId,
      });
    });
  },
);

describe(
  "installing a skill from Capabilities over the real Gateway, with the skip setting off",
  { timeout: 600_000 },
  () => {
    const gateway = useGateway({ GOATCITADEL_FEATURE_SETTINGS_APPROVAL_SKIP_ENABLED: "false" });

    it("waits for each step when the setting is off", async () => {
      const checked = await gateway.checkPack("himalaya", "check-himalaya");
      expect(checked.step).toBe("check_passed");
      expect((await gateway.readInstalls()).operatorApprovalSkip).toBe(false);

      const install = await gateway.requestStep(checked.snapshotId, "install_inactive");

      expect(install.status).toBe("waiting");
      expect(await gateway.readApproval(install.approvalId)).toMatchObject({
        kind: "skill_hub.lifecycle",
        status: "pending",
      });
      expect(await gateway.readInstall(checked.snapshotId)).toMatchObject({
        step: "waiting_install",
        approvalId: install.approvalId,
      });

      // The operator approves it in the Inbox, and its own effect installs the skill, still switched off.
      await gateway.approve(install.approvalId);
      await vi.waitFor(
        async () => expect((await gateway.readInstall(checked.snapshotId))?.step).toBe("installed_off"),
        STEP_WAIT,
      );

      const activate = await gateway.requestStep(checked.snapshotId, "activate");

      expect(activate.status).toBe("waiting");
      expect(await gateway.readInstall(checked.snapshotId)).toMatchObject({
        step: "waiting_switch_on",
        approvalId: activate.approvalId,
      });
      expect((await gateway.readSkill("extra:himalaya"))?.callable ?? false).toBe(false);

      await gateway.approve(activate.approvalId);
      expect(await gateway.waitUntilSwitchedOn(checked.snapshotId, "extra:himalaya")).toMatchObject({
        state: "on",
        callable: true,
      });
      // Nothing here was skipped: the operator answered both in the Inbox.
      expect(gateway.readApprovalAudit()).not.toContainEqual(
        expect.objectContaining({ event: "operator_approval_skipped" }),
      );
    });

    it("checks a source afresh after an install that didn't finish, as a new check", async () => {
      // Two checks of one pack, each asked to install; the second installs first, so the first one's install finds the
      // skill already there when its approval applies, and stops.
      const first = await gateway.checkPack("github-cli", "check-github-cli-first");
      const second = await gateway.checkPack("github-cli", "check-github-cli-second");
      expect([first.step, second.step]).toEqual(["check_passed", "check_passed"]);
      const firstInstall = await gateway.requestStep(first.snapshotId, "install_inactive");
      const secondInstall = await gateway.requestStep(second.snapshotId, "install_inactive");
      expect([firstInstall.status, secondInstall.status]).toEqual(["waiting", "waiting"]);
      await gateway.approve(secondInstall.approvalId);
      await vi.waitFor(
        async () => expect((await gateway.readInstall(second.snapshotId))?.step).toBe("installed_off"),
        STEP_WAIT,
      );
      await gateway.approve(firstInstall.approvalId);
      await vi.waitFor(
        async () => expect((await gateway.readInstall(first.snapshotId))?.step).toBe("failed"),
        STEP_WAIT,
      );
      const failed = await gateway.readInstall(first.snapshotId);
      expect(failed?.failure).toBe("GoatCitadel's checks stopped the install.");

      // Asking for the same step again runs nothing: here the checks refuse it, since the skill is there now.
      const retry = await gateway.inject("POST", OPERATIONS_URL, {
        workspaceId: WORKSPACE_ID,
        snapshotId: first.snapshotId,
        operationKind: "install_inactive",
      });
      expect(retry.statusCode, retry.body).toBe(409);
      expect(retry.json()).toMatchObject({ details: { reason: "blocked" } });
      expect((await gateway.readInstall(first.snapshotId))?.step).toBe("failed");

      // A fresh check (a new key) is a new check, not the stopped one: here it finds the skill installed already.
      const again = await gateway.checkPack("github-cli", "check-github-cli-again");
      expect(again.snapshotId).not.toBe(first.snapshotId);
      expect(again.step).toBe("blocked");
      expect(again.blockers).toEqual(expect.arrayContaining(["CANDIDATE_ALREADY_EXISTS"]));
      expect((await gateway.readInstall(first.snapshotId))?.step).toBe("failed");
    });
  },
);

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
