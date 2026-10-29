import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  type CapabilitySkillsResponse,
  type CapabilitySkillUsageResponse,
} from "@goatcitadel/contracts";
import { CapabilitySkillActionsService } from "../services/capability-skill-actions-service.js";
import { capabilitySkillsRoutes } from "./capability-skills.js";

const USAGE_URL = "/api/v1/capabilities/skills/usage";

const RESPONSE: CapabilitySkillUsageResponse = {
  since: "2025-10-28T00:00:00.000Z",
  generatedAt: "2026-10-28T00:00:00.000Z",
  skills: [{ skillId: "research", uses: 3, lastUsedAt: "2026-10-20T00:00:00.000Z" }],
};

describe("capability skills usage route", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function build(services: Record<string, unknown>) {
    app = Fastify();
    await app.register(rateLimit, { global: false });
    app.decorate("services", services as never);
    await app.register(capabilitySkillsRoutes);
    return app;
  }

  it("returns the use counts without storing them", async () => {
    const read = vi.fn(async () => RESPONSE);
    const server = await build({ capabilitySkills: { usage: { read } } });

    const response = await server.inject({ method: "GET", url: USAGE_URL });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(RESPONSE);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(read).toHaveBeenCalledWith({ refresh: false });
  });

  it.each([
    ["true", true],
    ["false", false],
  ])("reads with refresh=%s", async (value, refresh) => {
    const read = vi.fn(async () => RESPONSE);
    const server = await build({ capabilitySkills: { usage: { read } } });

    const response = await server.inject({ method: "GET", url: `${USAGE_URL}?refresh=${value}` });

    expect(response.statusCode).toBe(200);
    expect(read).toHaveBeenCalledWith({ refresh });
  });

  it("answers 503 when uses can't be read", async () => {
    const read = vi.fn(async () => {
      throw new Error("database is locked at C:\\data\\goatcitadel.sqlite");
    });
    const server = await build({ capabilitySkills: { usage: { read } } });

    const response = await server.inject({ method: "GET", url: USAGE_URL });

    expect(response.statusCode).toBe(503);
    expect(response.body).toContain("Skill use counts can't be read right now.");
    // The real reason stays in the log; the answer carries plain wording only, and no counts.
    expect(response.body).not.toContain("sqlite");
    expect(response.body).not.toContain("skills");
  });

  it("answers 503 when the usage service is not composed", async () => {
    const server = await build({});

    const response = await server.inject({ method: "GET", url: USAGE_URL });

    expect(response.statusCode).toBe(503);
    expect(response.body).toContain("Skill use counts can't be read right now.");
  });

  it("rejects unknown query fields", async () => {
    const read = vi.fn(async () => RESPONSE);
    const server = await build({ capabilitySkills: { usage: { read } } });

    const response = await server.inject({ method: "GET", url: `${USAGE_URL}?window=30` });

    expect(response.statusCode).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects a refresh value that isn't true or false", async () => {
    const read = vi.fn(async () => RESPONSE);
    const server = await build({ capabilitySkills: { usage: { read } } });

    const response = await server.inject({ method: "GET", url: `${USAGE_URL}?refresh=yes` });

    expect(response.statusCode).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });

  it("sets the 30 a minute limit", async () => {
    const server = await build({ capabilitySkills: { usage: { read: vi.fn(async () => RESPONSE) } } });

    const response = await server.inject({ method: "GET", url: USAGE_URL });

    expect(response.headers["x-ratelimit-limit"]).toBe("30");
  });
});

const LIST_URL = "/api/v1/capabilities/skills";
const DETAIL_URL = "/api/v1/capabilities/skills/detail";

const LIST: CapabilitySkillsResponse = {
  workspaceId: "default",
  items: [
    {
      skillId: "bundled:research",
      name: "research",
      description: "Research with citations.",
      category: "research",
      origin: "built_in",
      state: "on",
      callable: true,
      revision: 2,
      pinned: false,
      lifecycleState: "trusted",
      tags: [],
      hiddenInWorkspace: false,
    },
  ],
  candidatesWaiting: 1,
  operatorApprovalSkip: false,
  issues: [],
  generatedAt: "2026-10-28T00:00:00.000Z",
};

describe("capability skills list and detail routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function build(skills: Record<string, unknown> | undefined) {
    app = Fastify();
    await app.register(rateLimit, { global: false });
    app.decorate("services", (skills ? { capabilitySkills: { usage: { read: vi.fn() }, skills } } : {}) as never);
    await app.register(capabilitySkillsRoutes);
    return app;
  }

  it("returns the list with no-store", async () => {
    const list = vi.fn(async () => LIST);
    const server = await build({ list, detail: vi.fn() });

    const response = await server.inject({ method: "GET", url: `${LIST_URL}?workspaceId=default` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(LIST);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-ratelimit-limit"]).toBe("60");
    expect(list).toHaveBeenCalledWith("default");
  });

  it("returns one skill's details with no-store", async () => {
    const detail = vi.fn(async () => ({
      skillId: "bundled:research",
      instructionBody: "# Research",
      keywords: [],
      declaredTools: [],
      requires: [],
    }));
    const server = await build({ list: vi.fn(), detail });

    const response = await server.inject({
      method: "GET",
      url: `${DETAIL_URL}?workspaceId=default&skillId=${encodeURIComponent("bundled:research")}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ skillId: "bundled:research", instructionBody: "# Research" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-ratelimit-limit"]).toBe("60");
    expect(detail).toHaveBeenCalledWith("default", "bundled:research");
  });

  it("returns 404 for an unknown skill's details", async () => {
    const detail = vi.fn(async () => {
      throw new NotFoundError({ entity: "Skill", id: "extra:missing" });
    });
    const server = await build({ list: vi.fn(), detail });

    const response = await server.inject({
      method: "GET",
      url: `${DETAIL_URL}?workspaceId=default&skillId=${encodeURIComponent("extra:missing")}`,
    });

    expect(response.statusCode).toBe(404);
  });

  it("rejects unknown query fields", async () => {
    const list = vi.fn(async () => LIST);
    const detail = vi.fn();
    const server = await build({ list, detail });

    for (const url of [
      `${LIST_URL}?workspaceId=default&kind=skill`,
      `${LIST_URL}`,
      `${DETAIL_URL}?workspaceId=default&skillId=bundled%3Aresearch&full=true`,
      `${DETAIL_URL}?workspaceId=default`,
      `${DETAIL_URL}?workspaceId=default&skillId=${"x".repeat(301)}`,
      `${LIST_URL}?workspaceId=${"w".repeat(201)}`,
    ]) {
      const response = await server.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(400);
    }
    expect(list).not.toHaveBeenCalled();
    expect(detail).not.toHaveBeenCalled();
  });

  it("answers 503 with plain wording when the skills can't be read", async () => {
    const list = vi.fn(async () => {
      throw new ServiceUnavailableError("Skills can't be read right now.");
    });
    const server = await build({ list, detail: vi.fn() });

    const response = await server.inject({ method: "GET", url: `${LIST_URL}?workspaceId=default` });

    expect(response.statusCode).toBe(503);
    expect(response.body).toContain("Skills can't be read right now.");
  });

  it("answers 503 when the skills list is not composed", async () => {
    const server = await build(undefined);

    const list = await server.inject({ method: "GET", url: `${LIST_URL}?workspaceId=default` });
    const detail = await server.inject({ method: "GET", url: `${DETAIL_URL}?workspaceId=default&skillId=a` });

    expect(list.statusCode).toBe(503);
    expect(detail.statusCode).toBe(503);
  });
});

const STATE_URL = "/api/v1/capabilities/skills/state";
const STATE_BODY = { workspaceId: "default", skillId: "bundled:research", state: "disabled", expectedRevision: 3 };

describe("capability skill state route", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  /** `operator: false` makes the operator check refuse, as it does for a caller without operator sign-in. */
  async function build(
    actions: Record<string, unknown> | undefined,
    options: { operator?: boolean; actor?: string } = {},
  ) {
    const requireOperatorAuth = vi.fn(async (_request: FastifyRequest, reply: FastifyReply) => {
      if (options.operator === false) return reply.code(403).send({ error: "Operator authentication is required." });
    });
    app = Fastify();
    await app.register(rateLimit, { global: false });
    app.decorateRequest("authActorId", "");
    app.addHook("onRequest", async (request) => {
      request.authActorId = options.actor ?? "operator-1";
    });
    app.decorate("requireOperatorAuth", requireOperatorAuth as never);
    app.decorate(
      "services",
      (actions ? { capabilitySkills: { usage: { read: vi.fn() }, skills: {}, actions } } : {}) as never,
    );
    await app.register(capabilitySkillsRoutes);
    return { server: app, requireOperatorAuth };
  }

  it.each([
    [{ status: "approved", approvalId: "approval-1" }, 202],
    [{ status: "waiting", approvalId: "approval-1" }, 202],
    [{ status: "unchanged" }, 200],
  ] as const)("answers %o with %i", async (outcome, statusCode) => {
    const setState = vi.fn(async () => outcome);
    const { server, requireOperatorAuth } = await build({ setState });

    const response = await server.inject({ method: "POST", url: STATE_URL, payload: STATE_BODY });

    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toEqual(outcome);
    expect(response.headers["cache-control"]).toBe("no-store");
    // The switch is the operator's own: the operator check runs, and the operator is the actor.
    expect(requireOperatorAuth).toHaveBeenCalledTimes(1);
    expect(setState).toHaveBeenCalledExactlyOnceWith({ ...STATE_BODY, actorId: "operator-1" });
  });

  it("names the caller by address when sign-in gives no actor", async () => {
    const setState = vi.fn(async () => ({ status: "unchanged" }));
    const { server } = await build({ setState }, { actor: " " });

    await server.inject({ method: "POST", url: STATE_URL, payload: STATE_BODY });

    expect(setState).toHaveBeenCalledWith({ ...STATE_BODY, actorId: "ip:127.0.0.1" });
  });

  it("refuses a caller without operator access", async () => {
    const setState = vi.fn();
    const { server } = await build({ setState }, { operator: false });

    const response = await server.inject({ method: "POST", url: STATE_URL, payload: STATE_BODY });

    expect(response.statusCode).toBe(403);
    expect(setState).not.toHaveBeenCalled();
  });

  it("rejects a body that tries to choose the skip", async () => {
    const setState = vi.fn();
    const { server } = await build({ setState });

    for (const extra of [
      { skip: true },
      { operatorApprovalSkip: true },
      { resolutionNote: "Applied without asking." },
      { decision: "approve" },
      { note: "Pause for review" },
    ]) {
      const response = await server.inject({ method: "POST", url: STATE_URL, payload: { ...STATE_BODY, ...extra } });
      expect(response.statusCode, JSON.stringify(extra)).toBe(400);
    }
    expect(setState).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown state", { state: "paused" }],
    ["a zero revision", { expectedRevision: 0 }],
    ["a fractional revision", { expectedRevision: 1.5 }],
    ["an empty skill id", { skillId: "" }],
    ["a skill id over 300 characters", { skillId: "s".repeat(301) }],
    ["a workspace id over 200 characters", { workspaceId: "w".repeat(201) }],
  ])("rejects %s", async (_name, change) => {
    const setState = vi.fn();
    const { server } = await build({ setState });

    const response = await server.inject({ method: "POST", url: STATE_URL, payload: { ...STATE_BODY, ...change } });

    expect(response.statusCode).toBe(400);
    expect(setState).not.toHaveBeenCalled();
  });

  it("passes a pinned skill's refusal through as 409 and creates no approval", async () => {
    // The real switch over the skill state owner's own refusal for a pinned skill.
    const resolveApproval = vi.fn();
    const appendApprovalAudit = vi.fn();
    const actions = new CapabilitySkillActionsService({
      setSkillState: vi.fn(async () => {
        throw new ConflictError({
          message: "Pinned skill bundled:research cannot be changed directly; create a skill mutation proposal first.",
        });
      }),
      resolveApproval,
      appendApprovalAudit,
      deploymentProfile: () => "trusted_local",
      readApprovalSkipSetting: async () => true,
    });
    const { server } = await build(actions as unknown as Record<string, unknown>);

    const response = await server.inject({ method: "POST", url: STATE_URL, payload: STATE_BODY });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("This skill is pinned. Change it through a proposal in Library.");
    expect(response.body).not.toContain("bundled:research");
    expect(resolveApproval).not.toHaveBeenCalled();
    expect(appendApprovalAudit).not.toHaveBeenCalled();
  });

  it("passes a stale revision's 409 through as the owner wrote it", async () => {
    const setState = vi.fn(async () => {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: "runtime_skill bundled:research changed since revision 3",
      });
    });
    const { server } = await build({ setState });

    const response = await server.inject({ method: "POST", url: STATE_URL, payload: STATE_BODY });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "WRITE_CONFLICT",
      error: "runtime_skill bundled:research changed since revision 3",
    });
  });

  it("sets the 30 a minute limit", async () => {
    const { server } = await build({ setState: vi.fn(async () => ({ status: "unchanged" })) });

    const response = await server.inject({ method: "POST", url: STATE_URL, payload: STATE_BODY });

    expect(response.headers["x-ratelimit-limit"]).toBe("30");
  });

  it("answers 503 when the switch is not composed", async () => {
    const { server } = await build(undefined);

    const response = await server.inject({ method: "POST", url: STATE_URL, payload: STATE_BODY });

    expect(response.statusCode).toBe(503);
    expect(response.body).toContain("Skills can't be switched right now.");
  });
});
