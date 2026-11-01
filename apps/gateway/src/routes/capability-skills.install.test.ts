import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type CapabilitySkillDiscoverResponse,
  type CapabilitySkillInstall,
  type CapabilitySkillInstallsResponse,
} from "@goatcitadel/contracts";
import {
  CapabilitySkillActionsService,
  type CapabilitySkillActionSources,
} from "../services/capability-skill-actions-service.js";
import { hubApproval, hubItem } from "../services/capability-skill-install.test-support.js";
import { capabilitySkillsRoutes } from "./capability-skills.js";

const REVIEWS_URL = "/api/v1/capabilities/skills/reviews";
const INSTALLS_URL = "/api/v1/capabilities/skills/installs";
const OPERATIONS_URL = "/api/v1/capabilities/skills/operations";
const REVIEW_BODY = {
  workspaceId: "default",
  source: { kind: "pack", packId: "himalaya" },
  idempotencyKey: "check-7f0c2a59",
};
const OPERATION_BODY = { workspaceId: "default", snapshotId: "skill-hub-review-1", operationKind: "install_inactive" };

const INSTALL: CapabilitySkillInstall = {
  snapshotId: "skill-hub-review-1",
  name: "Email over IMAP/SMTP (Himalaya)",
  description: "Read, search, organise and send mail for any IMAP/SMTP account.",
  source: { kind: "pack", packId: "himalaya" },
  step: "check_passed",
  blockers: [],
  asksFor: {
    tools: ["tool:shell.exec"],
    networkHosts: [],
    envVars: [],
    readsFiles: [],
    writesFiles: [],
    includesScripts: false,
    requires: ["himalaya"],
  },
};

/** The real check and install steps over fake Skill Hub owners, so each route's plain mapping meets the owner's own errors. */
function realActions(overrides: Partial<CapabilitySkillActionSources> = {}): CapabilitySkillActionsService {
  return new CapabilitySkillActionsService({
    setSkillState: vi.fn(),
    resolveApproval: vi.fn(async () => ({})),
    readApproval: vi.fn(),
    appendApprovalAudit: vi.fn(async () => undefined),
    deploymentProfile: () => "trusted_local",
    readApprovalSkipSetting: async () => true,
    reviewSkillHubSource: vi.fn(async () => ({ snapshot: { snapshotId: "skill-hub-review-1" }, replayed: false })),
    listSkillHub: vi.fn(async () => ({ items: [hubItem()] })),
    createSkillHubApproval: vi.fn(async () => ({ approval: hubApproval("install_inactive", "pending") })),
    // An ordinary check, not one a plugin brought: no plugin record is read for it.
    findSkillHubSnapshot: vi.fn(async () => ({
      sourceProvider: "local",
      sourceRef: "skills/import-packs/himalaya",
      workspaceId: "default",
    })),
    listPluginRecords: vi.fn(async () => []),
    ...overrides,
  });
}

describe("capability skill check and install routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  /** `operator: false` makes the operator check refuse, as it does for a caller without operator sign-in. */
  async function build(
    owners: { skills?: Record<string, unknown>; actions?: Record<string, unknown> } | undefined,
    options: { operator?: boolean } = {},
  ) {
    const requireOperatorAuth = vi.fn(async (_request: FastifyRequest, reply: FastifyReply) => {
      if (options.operator === false) return reply.code(403).send({ error: "Operator authentication is required." });
    });
    app = Fastify();
    await app.register(rateLimit, { global: false });
    app.decorateRequest("authActorId", "");
    app.addHook("onRequest", async (request) => {
      request.authActorId = "operator-1";
    });
    app.decorate("requireOperatorAuth", requireOperatorAuth as never);
    app.decorate(
      "services",
      (owners
        ? { capabilitySkills: { usage: { read: vi.fn() }, skills: owners.skills ?? {}, actions: owners.actions ?? {} } }
        : {}) as never,
    );
    await app.register(capabilitySkillsRoutes);
    return { server: app, requireOperatorAuth };
  }

  describe("POST reviews", () => {
    it.each([
      [false, 201],
      [true, 200],
    ])("answers a check (replayed: %s) with %i and the install, without storing it", async (replayed, statusCode) => {
      const checkSource = vi.fn(async () => ({ install: INSTALL, replayed }));
      const { server, requireOperatorAuth } = await build({ actions: { checkSource } });

      const response = await server.inject({ method: "POST", url: REVIEWS_URL, payload: REVIEW_BODY });

      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toEqual(INSTALL);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["x-ratelimit-limit"]).toBe("10");
      expect(requireOperatorAuth).toHaveBeenCalledTimes(1);
      expect(checkSource).toHaveBeenCalledExactlyOnceWith({ ...REVIEW_BODY, actorId: "operator-1" });
    });

    it("checks a Git address", async () => {
      const checkSource = vi.fn(async () => ({ install: INSTALL, replayed: false }));
      const { server } = await build({ actions: { checkSource } });
      const source = { kind: "git", sourceRef: "https://github.com/example/notes" };

      const response = await server.inject({ method: "POST", url: REVIEWS_URL, payload: { ...REVIEW_BODY, source } });

      expect(response.statusCode).toBe(201);
      expect(checkSource).toHaveBeenCalledWith({ ...REVIEW_BODY, source, actorId: "operator-1" });
    });

    it("refuses a caller without operator access", async () => {
      const checkSource = vi.fn();
      const { server } = await build({ actions: { checkSource } }, { operator: false });

      const response = await server.inject({ method: "POST", url: REVIEWS_URL, payload: REVIEW_BODY });

      expect(response.statusCode).toBe(403);
      expect(checkSource).not.toHaveBeenCalled();
    });

    it.each([
      ["an extra key", { ...REVIEW_BODY, skip: true }],
      ["a source type", { ...REVIEW_BODY, sourceType: "remote_bundle" }],
      ["both a pack and an address", { ...REVIEW_BODY, source: { kind: "pack", packId: "himalaya", sourceRef: "x" } }],
      ["an unknown source kind", { ...REVIEW_BODY, source: { kind: "path", sourceRef: "/srv/skills/a" } }],
      ["a pack id that isn't one", { ...REVIEW_BODY, source: { kind: "pack", packId: "../bundled" } }],
      ["an empty address", { ...REVIEW_BODY, source: { kind: "git", sourceRef: "" } }],
      ["an address over 2048 characters", { ...REVIEW_BODY, source: { kind: "git", sourceRef: "h".repeat(2_049) } }],
      ["a key with spaces", { ...REVIEW_BODY, idempotencyKey: "check one" }],
      ["no key", { workspaceId: "default", source: REVIEW_BODY.source }],
      ["a workspace id over 200 characters", { ...REVIEW_BODY, workspaceId: "w".repeat(201) }],
    ])("rejects %s", async (_label, payload) => {
      const checkSource = vi.fn();
      const { server } = await build({ actions: { checkSource } });

      const response = await server.inject({ method: "POST", url: REVIEWS_URL, payload });

      expect(response.statusCode).toBe(400);
      expect(checkSource).not.toHaveBeenCalled();
    });

    it("keeps the review's reason code on a rejected source", async () => {
      const actions = realActions({
        reviewSkillHubSource: vi.fn(async (): Promise<never> => {
          throw new ValidationError({
            field: "UNKNOWN_FRONTMATTER_DIMENSION",
            message: "Skill frontmatter declares an unknown permission-bearing dimension.",
          });
        }),
      });
      const { server } = await build({ actions: actions as unknown as Record<string, unknown> });

      const response = await server.inject({ method: "POST", url: REVIEWS_URL, payload: REVIEW_BODY });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({
        error: "This skill didn't pass GoatCitadel's checks.",
        code: "SKILL_SOURCE_REFUSED",
        details: { reason: "UNKNOWN_FRONTMATTER_DIMENSION" },
      });
    });

    it("refuses a Git host outside the trusted forges before reviewing", async () => {
      const reviewSkillHubSource = vi.fn();
      const actions = realActions({ reviewSkillHubSource });
      const { server } = await build({ actions: actions as unknown as Record<string, unknown> });

      const response = await server.inject({
        method: "POST",
        url: REVIEWS_URL,
        payload: { ...REVIEW_BODY, source: { kind: "git", sourceRef: "https://git.example.com/team/notes" } },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({
        error: "GoatCitadel installs skills only from GitHub, GitLab, Bitbucket or Codeberg.",
        code: "SKILL_SOURCE_REFUSED",
        details: { reason: "UNTRUSTED_GIT_HOST" },
      });
      expect(reviewSkillHubSource).not.toHaveBeenCalled();
    });

    it("answers a source the check can't read with SOURCE_REFUSED and no Skill Hub wording", async () => {
      const actions = realActions({
        reviewSkillHubSource: vi.fn(async (): Promise<never> => {
          throw new ValidationError({
            field: "sourceRef",
            message: "Skill Hub source could not be materialized into an exact validated tree.",
          });
        }),
      });
      const { server } = await build({ actions: actions as unknown as Record<string, unknown> });

      const response = await server.inject({ method: "POST", url: REVIEWS_URL, payload: REVIEW_BODY });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({
        error: "GoatCitadel can't check a skill from this source.",
        code: "SKILL_SOURCE_REFUSED",
        details: { reason: "SOURCE_REFUSED" },
      });
      expect(response.body).not.toContain("Skill Hub");
    });

    it("answers 503 when the check isn't composed", async () => {
      const { server } = await build(undefined);

      const response = await server.inject({ method: "POST", url: REVIEWS_URL, payload: REVIEW_BODY });

      expect(response.statusCode).toBe(503);
      expect(response.body).toContain("Skills can't be checked right now.");
    });
  });

  describe("GET installs", () => {
    const INSTALLS: CapabilitySkillInstallsResponse = {
      workspaceId: "default",
      installs: [{ ...INSTALL, step: "installed_off" }],
      operatorApprovalSkip: true,
      generatedAt: "2026-10-29T00:00:00.000Z",
    };

    it("returns the installs in progress without storing them", async () => {
      const installs = vi.fn(async () => INSTALLS);
      const { server, requireOperatorAuth } = await build({ skills: { installs } });

      const response = await server.inject({ method: "GET", url: `${INSTALLS_URL}?workspaceId=default` });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(INSTALLS);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["x-ratelimit-limit"]).toBe("60");
      expect(requireOperatorAuth).toHaveBeenCalledTimes(1);
      expect(installs).toHaveBeenCalledExactlyOnceWith("default", undefined);
    });

    it("reads one install by its snapshot", async () => {
      const installs = vi.fn(async () => INSTALLS);
      const { server } = await build({ skills: { installs } });

      const response = await server.inject({
        method: "GET",
        url: `${INSTALLS_URL}?workspaceId=default&snapshotId=skill-hub-review-1`,
      });

      expect(response.statusCode).toBe(200);
      expect(installs).toHaveBeenCalledExactlyOnceWith("default", "skill-hub-review-1");
    });

    it("refuses a caller without operator access", async () => {
      const installs = vi.fn();
      const { server } = await build({ skills: { installs } }, { operator: false });

      const response = await server.inject({ method: "GET", url: `${INSTALLS_URL}?workspaceId=default` });

      expect(response.statusCode).toBe(403);
      expect(installs).not.toHaveBeenCalled();
    });

    it("rejects unknown query fields", async () => {
      const installs = vi.fn();
      const { server } = await build({ skills: { installs } });

      for (const url of [
        INSTALLS_URL,
        `${INSTALLS_URL}?workspaceId=default&limit=500`,
        `${INSTALLS_URL}?workspaceId=default&snapshotId=`,
        `${INSTALLS_URL}?workspaceId=default&snapshotId=${"s".repeat(257)}`,
      ]) {
        const response = await server.inject({ method: "GET", url });
        expect(response.statusCode, url).toBe(400);
      }
      expect(installs).not.toHaveBeenCalled();
    });

    it("reads a check id as long as a step may name, the Skill Hub's own bound", async () => {
      const installs = vi.fn(async () => INSTALLS);
      const requestStep = vi.fn(async () => ({ status: "waiting", approvalId: "approval-1" }));
      const { server } = await build({ skills: { installs }, actions: { requestStep } });
      const longest = "s".repeat(256);

      const read = await server.inject({
        method: "GET",
        url: `${INSTALLS_URL}?workspaceId=default&snapshotId=${longest}`,
      });
      const step = await server.inject({
        method: "POST",
        url: OPERATIONS_URL,
        payload: { ...OPERATION_BODY, snapshotId: longest },
      });
      const tooLong = await server.inject({
        method: "POST",
        url: OPERATIONS_URL,
        payload: { ...OPERATION_BODY, snapshotId: `${longest}s` },
      });

      expect(read.statusCode).toBe(200);
      expect(installs).toHaveBeenCalledExactlyOnceWith("default", longest);
      expect(step.statusCode).toBe(202);
      expect(tooLong.statusCode).toBe(400);
      expect(requestStep).toHaveBeenCalledTimes(1);
    });

    it("answers 503 when the installs aren't composed", async () => {
      const { server } = await build(undefined);

      const response = await server.inject({ method: "GET", url: `${INSTALLS_URL}?workspaceId=default` });

      expect(response.statusCode).toBe(503);
      expect(response.body).toContain("Skill installs can't be read right now.");
    });
  });

  describe("POST operations", () => {
    it.each([
      [{ status: "approved", approvalId: "approval-1" }, 202],
      [{ status: "waiting", approvalId: "approval-1" }, 202],
    ] as const)("answers %o with %i", async (outcome, statusCode) => {
      const requestStep = vi.fn(async () => outcome);
      const { server, requireOperatorAuth } = await build({ actions: { requestStep } });

      const response = await server.inject({ method: "POST", url: OPERATIONS_URL, payload: OPERATION_BODY });

      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toEqual(outcome);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["x-ratelimit-limit"]).toBe("20");
      expect(requireOperatorAuth).toHaveBeenCalledTimes(1);
      expect(requestStep).toHaveBeenCalledExactlyOnceWith({ ...OPERATION_BODY, actorId: "operator-1" });
    });

    it("refuses a caller without operator access", async () => {
      const requestStep = vi.fn();
      const { server } = await build({ actions: { requestStep } }, { operator: false });

      const response = await server.inject({ method: "POST", url: OPERATIONS_URL, payload: OPERATION_BODY });

      expect(response.statusCode).toBe(403);
      expect(requestStep).not.toHaveBeenCalled();
    });

    it.each([
      ["a body that tries to choose the skip", { ...OPERATION_BODY, skip: true }],
      ["a resolution note", { ...OPERATION_BODY, resolutionNote: "Applied without asking." }],
      ["a revoke", { ...OPERATION_BODY, operationKind: "revoke" }],
      ["a staged update", { ...OPERATION_BODY, operationKind: "stage_update_candidate" }],
      ["a session id", { ...OPERATION_BODY, sessionId: "session-1" }],
      ["an empty check id", { ...OPERATION_BODY, snapshotId: "" }],
    ])("rejects %s", async (_label, payload) => {
      const requestStep = vi.fn();
      const { server } = await build({ actions: { requestStep } });

      const response = await server.inject({ method: "POST", url: OPERATIONS_URL, payload });

      expect(response.statusCode).toBe(400);
      expect(requestStep).not.toHaveBeenCalled();
    });

    it("passes a blocked operation's blockers through as 409", async () => {
      const resolveApproval = vi.fn();
      const actions = realActions({
        resolveApproval,
        // The Hub approval owner's own guard refusal, as it writes it.
        createSkillHubApproval: vi.fn(async (): Promise<never> => {
          throw new ConflictError({
            code: "STATE_CONFLICT",
            message: "Skill Hub install_inactive is blocked: RUNTIME_ALREADY_EXISTS, SOURCE_ALREADY_INSTALLED.",
            details: {
              blockers: ["RUNTIME_ALREADY_EXISTS", "SOURCE_ALREADY_INSTALLED"],
              snapshotId: "skill-hub-review-1",
            },
          });
        }),
      });
      const { server } = await build({ actions: actions as unknown as Record<string, unknown> });

      const response = await server.inject({ method: "POST", url: OPERATIONS_URL, payload: OPERATION_BODY });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: "GoatCitadel's checks don't allow this step right now.",
        code: "STATE_CONFLICT",
        details: { reason: "blocked", blockers: ["RUNTIME_ALREADY_EXISTS", "SOURCE_ALREADY_INSTALLED"] },
      });
      expect(response.body).not.toContain("Skill Hub");
      expect(resolveApproval).not.toHaveBeenCalled();
    });

    it("answers a refusal without codes with the same plain copy and no blockers", async () => {
      const actions = realActions({
        // A broken invariant in the Hub approval owner: its own words name Skill Hub, and it lists no codes.
        createSkillHubApproval: vi.fn(async (): Promise<never> => {
          throw new ConflictError({
            code: "STATE_CONFLICT",
            message: "Created Skill Hub approval did not preserve the operation intent.",
          });
        }),
      });
      const { server } = await build({ actions: actions as unknown as Record<string, unknown> });

      const response = await server.inject({ method: "POST", url: OPERATIONS_URL, payload: OPERATION_BODY });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: "GoatCitadel's checks don't allow this step right now.",
        code: "STATE_CONFLICT",
        details: { reason: "blocked", blockers: [] },
      });
      expect(response.body).not.toContain("Skill Hub");
    });

    it("answers a check it can't find with a plain 404", async () => {
      const actions = realActions({
        createSkillHubApproval: vi.fn(async (): Promise<never> => {
          throw new NotFoundError({ entity: "Skill Hub snapshot", id: "skill-hub-review-1" });
        }),
      });
      const { server } = await build({ actions: actions as unknown as Record<string, unknown> });

      const response = await server.inject({ method: "POST", url: OPERATIONS_URL, payload: OPERATION_BODY });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: "This skill's check wasn't found. Check it again.",
        code: "ENTITY_NOT_FOUND",
      });
    });

    it("answers 503 when the install steps aren't composed", async () => {
      const { server } = await build(undefined);

      const response = await server.inject({ method: "POST", url: OPERATIONS_URL, payload: OPERATION_BODY });

      expect(response.statusCode).toBe(503);
      expect(response.body).toContain("Skills can't be installed right now.");
    });
  });
});

describe("capability skills discover route", () => {
  const DISCOVER_URL = "/api/v1/capabilities/skills/discover";
  const DISCOVER: CapabilitySkillDiscoverResponse = {
    query: "mail",
    items: [
      {
        id: "pack:himalaya",
        name: "Email over IMAP/SMTP (Himalaya)",
        description: "Read, search, organise and send mail for any IMAP/SMTP account.",
        category: "email",
        provider: "goatcitadel",
        providerLabel: "GoatCitadel",
        state: "available",
        install: { kind: "pack", packId: "himalaya" },
      },
    ],
    unavailableProviders: ["SkillsMP"],
    generatedAt: "2026-10-29T00:00:00.000Z",
  };
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function build(discover: Record<string, unknown> | undefined) {
    app = Fastify();
    await app.register(rateLimit, { global: false });
    app.decorate(
      "services",
      (discover ? { capabilitySkills: { usage: { read: vi.fn() }, skills: {}, actions: {}, discover } } : {}) as never,
    );
    await app.register(capabilitySkillsRoutes);
    return app;
  }

  it("returns what is on offer with no-store and the 30 a minute limit", async () => {
    const list = vi.fn(async () => DISCOVER);
    const server = await build({ list });

    const response = await server.inject({ method: "GET", url: `${DISCOVER_URL}?workspaceId=default&q=mail` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(DISCOVER);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-ratelimit-limit"]).toBe("30");
    expect(list).toHaveBeenCalledExactlyOnceWith("default", { query: "mail", refresh: false });
  });

  it("lists without a search term, and passes refresh on", async () => {
    const list = vi.fn(async () => DISCOVER);
    const server = await build({ list });

    await server.inject({ method: "GET", url: `${DISCOVER_URL}?workspaceId=default` });
    await server.inject({ method: "GET", url: `${DISCOVER_URL}?workspaceId=default&q=%20mail%20&refresh=true` });

    expect(list).toHaveBeenNthCalledWith(1, "default", { refresh: false });
    // The search term is trimmed before it counts.
    expect(list).toHaveBeenNthCalledWith(2, "default", { query: "mail", refresh: true });
  });

  it("rejects a one-character search", async () => {
    const list = vi.fn(async () => DISCOVER);
    const server = await build({ list });

    for (const q of ["a", "%20a%20", "%20%20%20", ""]) {
      const response = await server.inject({ method: "GET", url: `${DISCOVER_URL}?workspaceId=default&q=${q}` });
      expect(response.statusCode, q).toBe(400);
    }
    expect(list).not.toHaveBeenCalled();
  });

  it("rejects a search longer than 100 characters, a bad refresh and unknown fields", async () => {
    const list = vi.fn(async () => DISCOVER);
    const server = await build({ list });

    for (const query of [
      `workspaceId=default&q=${"x".repeat(101)}`,
      "workspaceId=default&refresh=yes",
      "workspaceId=default&limit=10",
      "q=mail",
    ]) {
      const response = await server.inject({ method: "GET", url: `${DISCOVER_URL}?${query}` });
      expect(response.statusCode, query).toBe(400);
    }
    const longest = await server.inject({
      method: "GET",
      url: `${DISCOVER_URL}?workspaceId=default&q=${"x".repeat(100)}`,
    });
    expect(longest.statusCode).toBe(200);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("answers 503 with plain wording when the listing isn't composed", async () => {
    const server = await build(undefined);

    const response = await server.inject({ method: "GET", url: `${DISCOVER_URL}?workspaceId=default` });

    expect(response.statusCode).toBe(503);
    expect(response.body).toContain("Skills to install can't be listed right now.");
  });
});
