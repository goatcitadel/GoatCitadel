import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  WORKFLOW_SKILL_CAPTURE_MARKER,
  type CandidateSkillDetailRecord,
  type CapabilitySkillDetail,
  type CapabilitySkillsResponse,
  type CapabilitySkillUsageResponse,
  type ChangePlanRecord,
  type ChatThreadResponse,
  type RoutingPreflightResult,
  type WorkflowSkillCaptureResult,
} from "@goatcitadel/contracts";
import { buildApp } from "./app.js";
import { RealtimeEventService } from "./services/realtime-event-service.js";
import { startFakeOpenAiCompatibleServer, type FakeOpenAiServer } from "./test/fake-openai-server.js";

/**
 * The Capabilities Skills routes over the real Gateway. The unit tests fake every source; these prove the composition
 * reaches the real owners on the migrated schema: the chat turn profile history for use counts, and the workspace's
 * skill list, catalog and approvals for the installed list. A fake OpenAI-compatible provider answers the Chat turns
 * that capture a self-authored skill; nothing leaves the machine.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const USAGE_URL = "/api/v1/capabilities/skills/usage";
const SKILLS_URL = "/api/v1/capabilities/skills";
const TOKEN = "capability-skills-test-operator-1234567890";
const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

/** A captured skill draft with every section workflow capture requires. */
const SKILL_MARKDOWN = [
  "---",
  "name: inspect-work-item",
  "description: Inspect a work item using reproducible checks.",
  "---",
  "# Inspect a work item",
  ...["When to use", "Inputs", "Instructions", "Failure handling", "Output", "Verification", "Boundaries"].flatMap(
    (heading) => [`\n## ${heading}\n`, "Check the supplied work item and report the observed result."],
  ),
].join("\n");

const ENV: Record<string, string> = {
  GATEWAY_HOST: "127.0.0.1",
  NODE_ENV: "test",
  GOATCITADEL_ALLOWED_ORIGINS: "http://localhost:5173",
  GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS: "false",
  // Workflow capture binds an authenticated operator, so these reads authenticate too.
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
  // Candidate promotion runs through a Change Plan.
  GOATCITADEL_FEATURE_EVOLUTION_CONTROL_PLANE_V1_ENABLED: "true",
  GOATCITADEL_FEATURE_CHAT_SKILL_INSTRUCTIONS_V1_ENABLED: "true",
};

describe("Capabilities skills over the real Gateway", { timeout: 300_000 }, () => {
  const originalEnv = new Map<string, string | undefined>();
  let root = "";
  let app: FastifyInstance | undefined;
  let provider: FakeOpenAiServer | undefined;
  let sequence = 0;
  const headers = () => ({ authorization: `Bearer ${TOKEN}`, "idempotency-key": `capability-skills-${++sequence}` });

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-capability-skills-"));
    provider = await startFakeOpenAiCompatibleServer((request) => {
      if (request.path === "/v1/models") return { body: { data: [{ id: "fake-chat", object: "model" }] } };
      if (request.path !== "/v1/chat/completions") return { status: 404 };
      const body = request.body as { messages?: unknown; stream?: boolean };
      // The capture draft turn carries the capture marker; it is answered with the skill draft.
      const content = JSON.stringify(body.messages).includes(WORKFLOW_SKILL_CAPTURE_MARKER)
        ? SKILL_MARKDOWN
        : "Read the supplied work item, check the result, and report discrepancies.";
      if (!body.stream) {
        return {
          body: { model: "fake-chat", choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] },
        };
      }
      const frame = {
        model: "fake-chat",
        choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }],
      };
      return { sseFrames: [JSON.stringify(frame), "[DONE]"] };
    });
    writeConfig(path.join(root, "config"), provider.baseUrl);
    for (const [key, value] of Object.entries({ ...ENV, GOATCITADEL_ROOT_DIR: root })) {
      originalEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
    app = await buildApp();
    await app.ready();
  }, 300_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
    await provider?.close();
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  });

  async function inject(method: "GET" | "POST", url: string, payload?: Record<string, unknown>) {
    const response = await app!.inject({ method, url, headers: headers(), ...(payload ? { payload } : {}) });
    return response;
  }

  async function readUsage(refresh: boolean): Promise<CapabilitySkillUsageResponse> {
    const response = await inject("GET", refresh ? `${USAGE_URL}?refresh=true` : USAGE_URL);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    return response.json<CapabilitySkillUsageResponse>();
  }

  async function readSkills(workspaceId: string): Promise<CapabilitySkillsResponse> {
    const response = await inject("GET", `${SKILLS_URL}?workspaceId=${encodeURIComponent(workspaceId)}`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    return response.json<CapabilitySkillsResponse>();
  }

  /** Records every realtime publish until the spy is restored. */
  function recordPublishes(): string[] {
    const published: string[] = [];
    const publish = RealtimeEventService.prototype.publishRealtime;
    vi.spyOn(RealtimeEventService.prototype, "publishRealtime").mockImplementation(function (
      this: RealtimeEventService,
      ...args: Parameters<RealtimeEventService["publishRealtime"]>
    ) {
      published.push(`${args[1]}:${args[0]}`);
      return publish.apply(this, args);
    });
    return published;
  }

  it("reads the real chat history, caches the answer, and announces nothing", async () => {
    const published = recordPublishes();

    const first = await readUsage(false);

    // A fresh install has no chat turns, so an empty list is the true answer (a failed read would be a 503).
    expect(first.skills).toEqual([]);
    expect(Date.parse(first.generatedAt) - Date.parse(first.since)).toBe(365 * 86_400_000);

    // The second read is the cached answer: it keeps the time of the read that filled the cache.
    expect(await readUsage(false)).toEqual(first);

    const refreshed = await readUsage(true);
    expect(Date.parse(refreshed.generatedAt)).toBeGreaterThanOrEqual(Date.parse(first.generatedAt));
    expect(published).toEqual([]);
    vi.restoreAllMocks();
  });

  it("includes the workspace's approved self-authored skills", async () => {
    const workspace = await inject("POST", "/api/v1/workspaces", { name: "Skills workspace" });
    expect(workspace.statusCode, workspace.body).toBe(201);
    const workspaceId = workspace.json<{ workspaceId: string }>().workspaceId;
    const session = await inject("POST", "/api/v1/chat/sessions", { title: "Capture a skill", workspaceId });
    expect(session.statusCode, session.body).toBe(201);
    const sessionUrl = `/api/v1/chat/sessions/${session.json<{ sessionId: string }>().sessionId}`;

    // Capture a skill from a completed Chat turn, the way "Save as skill" does.
    const send = async (content: string) => {
      const preflight = await inject("POST", `${sessionUrl}/route-preflight`, {
        action: "send",
        content,
        subagentPolicy: "off",
      });
      expect(preflight.statusCode, preflight.body).toBe(200);
      const { decision } = preflight.json<RoutingPreflightResult>();
      const sent = await inject("POST", `${sessionUrl}/agent-send/stream`, {
        content,
        subagentPolicy: "off",
        providerId: decision.effectiveProviderId,
        model: decision.effectiveModel,
        routeDecision: decision,
      });
      expect(sent.statusCode, sent.body.slice(0, 2000)).toBe(200);
      const thread = await inject("GET", `${sessionUrl}/thread`);
      const trace = thread.json<ChatThreadResponse>().turns.at(-1)!.trace;
      expect(trace.status).toBe("completed");
      return trace;
    };
    const source = await send("Inspect the supplied work item.");
    const prepared = await inject("POST", `${sessionUrl}/skill-captures/prepare`, { sourceTurnId: source.turnId });
    expect(prepared.statusCode, prepared.body).toBe(200);
    const draft = await send(prepared.json<{ prompt: string }>().prompt);
    const staged = await inject("POST", `${sessionUrl}/skill-captures/stage`, {
      draftTurnId: draft.turnId,
      reviewedContentSha256: sha256Hex(SKILL_MARKDOWN),
    });
    expect(staged.statusCode, staged.body).toBe(200);
    const captured = staged.json<WorkflowSkillCaptureResult>();
    const skillId = `extra:reviewed-${sha256Hex(captured.candidateId).slice(0, 12)}`;

    // Staged but not reviewed: a waiting candidate, and not yet a skill.
    const waiting = await readSkills(workspaceId);
    expect(waiting.candidatesWaiting).toBe(1);
    expect(waiting.items.some((item) => item.skillId === skillId)).toBe(false);

    await approveCandidate(captured, workspaceId);

    const listed = await readSkills(workspaceId);
    const item = listed.items.find((entry) => entry.skillId === skillId);
    expect(item).toMatchObject({
      skillId,
      origin: "self_authored",
      state: "on",
      callable: true,
      lifecycleState: "approved",
      // The skill state owner looks skills up without a workspace, so the switch can't reach this one.
      switchable: false,
    });
    const refused = await inject("POST", `${SKILLS_URL}/state`, {
      workspaceId,
      skillId,
      state: "disabled",
      expectedRevision: item!.revision,
    });
    expect(refused.statusCode, refused.body).toBe(404);
    expect(refused.json()).toEqual({ error: "This skill can't be switched from here.", code: "ENTITY_NOT_FOUND" });
    expect(listed).toMatchObject({ workspaceId, candidatesWaiting: 0, operatorApprovalSkip: false, issues: [] });
    // Self-authored skills belong to their workspace.
    expect((await readSkills("default")).items.some((item) => item.skillId === skillId)).toBe(false);

    const detail = await inject("GET", `${SKILLS_URL}/detail?workspaceId=${workspaceId}&skillId=${skillId}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json<CapabilitySkillDetail>()).toMatchObject({
      skillId,
      instructionBody: expect.stringContaining("Check the supplied work item"),
      provenance: { source: "workflow_capture" },
      catalogEntry: { capabilityId: `skill:${skillId}`, kind: "skill" },
    });
    const missing = await inject("GET", `${SKILLS_URL}/detail?workspaceId=default&skillId=${skillId}`);
    expect(missing.statusCode).toBe(404);
  });

  it("lists the shipped skills with their category and origin, serves their details, and announces nothing", async () => {
    // The shipped bundled skills, byte for byte. They load only now, so the capture turns above ran without them.
    fs.cpSync(path.join(REPO_ROOT, "skills", "bundled"), path.join(root, "skills", "bundled"), { recursive: true });
    const reloaded = await inject("POST", "/api/v1/skills/reload");
    expect(reloaded.statusCode, reloaded.body).toBe(200);
    const published = recordPublishes();

    const listed = await readSkills("default");

    expect(listed).toMatchObject({
      workspaceId: "default",
      candidatesWaiting: 0,
      operatorApprovalSkip: false,
      issues: [],
    });
    const research = listed.items.find((item) => item.skillId === "bundled:research");
    expect(research).toMatchObject({
      origin: "built_in",
      category: "research",
      state: "on",
      switchable: true,
    });
    expect(research).not.toHaveProperty("hiddenInWorkspace");
    expect(listed.items.every((item) => item.switchable)).toBe(true);
    // A revision that moved on is refused before any approval exists, in plain words with its own code.
    const stale = await inject("POST", `${SKILLS_URL}/state`, {
      workspaceId: "default",
      skillId: "bundled:research",
      state: "disabled",
      expectedRevision: research!.revision + 5,
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json()).toEqual({
      error: "This skill changed since you opened it. Reload and try again.",
      code: "WRITE_CONFLICT",
      details: { reason: "stale" },
    });
    expect(listed.items.every((item) => item.origin === "built_in")).toBe(true);
    const names = listed.items.map((item) => item.name);
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));

    const detail = await inject("GET", `${SKILLS_URL}/detail?workspaceId=default&skillId=bundled%3Aresearch`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.headers["cache-control"]).toBe("no-store");
    expect(detail.json<CapabilitySkillDetail>()).toMatchObject({
      skillId: "bundled:research",
      instructionBody: expect.stringMatching(/\S/),
      catalogEntry: { capabilityId: "skill:bundled:research", kind: "skill" },
    });
    expect((await inject("GET", `${SKILLS_URL}/detail?workspaceId=default&skillId=bundled%3Anone`)).statusCode).toBe(
      404,
    );
    expect(published).toEqual([]);
    vi.restoreAllMocks();
  });

  /** Promotes the captured version through its Change Plan and approves it, as the operator does in the cockpit. */
  async function approveCandidate(captured: WorkflowSkillCaptureResult, workspaceId: string): Promise<void> {
    const candidateUrl = `/api/v1/capabilities/candidates/${captured.candidateId}`;
    const readCandidate = async () => (await inject("GET", candidateUrl)).json<CandidateSkillDetailRecord>();
    const requested = await inject("POST", `${candidateUrl}/promote`, {
      expectedRevision: (await readCandidate()).revision,
      versionId: captured.versionId,
    });
    expect(requested.statusCode, requested.body).toBe(202);
    const planUrl = `/api/v1/change-plans/${requested.json<{ changePlan: ChangePlanRecord }>().changePlan.planId}`;
    const plan = (await inject("GET", `${planUrl}?workspaceId=${workspaceId}`)).json<ChangePlanRecord>();
    const reviewed = await inject("POST", `${planUrl}/responses`, {
      workspaceId,
      expectedRevision: plan.revision,
      actionId: plan.requiredAction!.actionId,
      actionNonce: plan.requiredAction!.actionNonce,
      values: {},
    });
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    const confirmation = reviewed.json<ChangePlanRecord>();
    const confirmed = await inject("POST", `${planUrl}/confirmations`, {
      workspaceId,
      expectedRevision: confirmation.revision,
      actionNonce: confirmation.requiredAction!.actionNonce,
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const approvalId = confirmed.json<ChangePlanRecord>().approvalRefs[0]!;
    const approved = await inject("POST", `/api/v1/approvals/${approvalId}/resolve`, { decision: "approve" });
    expect(approved.statusCode, approved.body).toBe(200);
    await vi.waitFor(
      async () => {
        const version = (await readCandidate()).versions.find((item) => item.versionId === captured.versionId);
        expect(version?.lifecycleState).toBe("approved");
      },
      { timeout: 20_000, interval: 100 },
    );
  }
});

/** Only the checked-in examples, plus the fake provider as the active model; never an operator's own config. */
function writeConfig(configDir: string, providerBaseUrl: string): void {
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
  config.llm = {
    activeProviderId: "fake-openai",
    activeModel: "fake-chat",
    providers: [
      {
        providerId: "fake-openai",
        label: "Skills test",
        baseUrl: providerBaseUrl,
        apiStyle: "openai-chat-completions",
        defaultModel: "fake-chat",
      },
    ],
  };
  config.assistant.approvalExplainer.enabled = false;
  fs.writeFileSync(path.join(configDir, "goatcitadel.json"), JSON.stringify(config));
  fs.writeFileSync(
    path.join(configDir, "llm-model-metadata.json"),
    JSON.stringify({
      version: 1,
      entries: { "fake-openai/fake-chat": { contextWindow: 128_000, outputTokenLimit: 16_000 } },
    }),
  );
}
