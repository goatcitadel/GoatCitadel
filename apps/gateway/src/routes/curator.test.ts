import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { curatorRoutes } from "./curator.js";

describe("curator routes", () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    if (!app) return;
    await app.close();
    app = null;
  });

  function makeMockCurator(
    overrides: Partial<{
      listStatus: () => unknown;
      archive: (input: unknown) => unknown;
      prune: (input: unknown) => unknown;
      listArchived: () => unknown;
      run: (input: unknown) => Promise<unknown>;
    }> = {},
  ) {
    return {
      listStatus:
        overrides.listStatus ?? vi.fn(() => ({ generatedAt: "2026-05-15T12:00:00Z", cycleDays: 7, items: [] })),
      archive:
        overrides.archive ??
        vi.fn((input: { skillId: string }) => ({
          skillId: input.skillId,
          archived: true,
          archivedAt: "2026-05-15T12:00:00Z",
          state: "disabled",
        })),
      prune:
        overrides.prune ??
        vi.fn((input: { skillId: string }) => ({
          skillId: input.skillId,
          pruned: true,
          prunedAt: "2026-05-15T12:00:00Z",
          filesRemoved: [],
        })),
      listArchived: overrides.listArchived ?? vi.fn(() => ({ generatedAt: "2026-05-15T12:00:00Z", items: [] })),
      run: overrides.run ?? vi.fn(async () => ({ runId: "curator-run-test", scheduled: false })),
    };
  }

  async function makeApp(curator: ReturnType<typeof makeMockCurator>) {
    const instance = Fastify();
    instance.decorate("services", { curator } as never);
    await instance.register(curatorRoutes);
    return instance;
  }

  it("GET /api/v1/curator/status returns the status response", async () => {
    const curator = makeMockCurator({
      listStatus: vi.fn(() => ({
        generatedAt: "2026-05-15T12:00:00Z",
        cycleDays: 7,
        items: [
          {
            skillId: "skill-a",
            name: "a",
            source: "managed",
            pinned: false,
            bundled: false,
            immune: false,
            state: "enabled",
            usageCount: 10,
            ageDays: 1,
            score: {
              honesty: 0.7,
              blockerQuality: 0.7,
              retryQuality: 0.7,
              toolEvidence: 0.7,
              actionability: 0.7,
              mean: 0.7,
            },
            signals: [],
            recommendation: "keep",
            archived: false,
          },
        ],
      })),
    });
    app = await makeApp(curator);
    const res = await app.inject({ method: "GET", url: "/api/v1/curator/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ cycleDays: 7 });
    expect(curator.listStatus).toHaveBeenCalled();
  });

  it("POST /api/v1/curator/archive accepts a valid request", async () => {
    const curator = makeMockCurator();
    app = await makeApp(curator);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/curator/archive",
      payload: { skillId: "skill-x", reason: "test", confirm: true },
    });
    expect(res.statusCode).toBe(200);
    expect(curator.archive).toHaveBeenCalledWith({ skillId: "skill-x", reason: "test", confirm: true });
  });

  it("POST /api/v1/curator/archive requires confirm: true", async () => {
    const curator = makeMockCurator();
    app = await makeApp(curator);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/curator/archive",
      payload: { skillId: "skill-x", reason: "test" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(curator.archive).not.toHaveBeenCalled();
  });

  it("POST /api/v1/curator/archive rejects missing skillId", async () => {
    const curator = makeMockCurator();
    app = await makeApp(curator);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/curator/archive",
      payload: {},
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(curator.archive).not.toHaveBeenCalled();
  });

  it("POST /api/v1/curator/prune requires confirm: true (rejects confirm: false)", async () => {
    const curator = makeMockCurator();
    app = await makeApp(curator);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/curator/prune",
      payload: { skillId: "skill-x", confirm: false },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(curator.prune).not.toHaveBeenCalled();
  });

  it("POST /api/v1/curator/prune passes through when confirm: true", async () => {
    const curator = makeMockCurator();
    app = await makeApp(curator);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/curator/prune",
      payload: { skillId: "skill-x", confirm: true },
    });
    expect(res.statusCode).toBe(200);
    expect(curator.prune).toHaveBeenCalledWith({ skillId: "skill-x", confirm: true });
  });

  it("GET /api/v1/curator/archived returns the list", async () => {
    const curator = makeMockCurator();
    app = await makeApp(curator);
    const res = await app.inject({ method: "GET", url: "/api/v1/curator/archived" });
    expect(res.statusCode).toBe(200);
    expect(curator.listArchived).toHaveBeenCalled();
  });

  it("POST /api/v1/curator/run accepts optional triggerMode", async () => {
    const curator = makeMockCurator();
    app = await makeApp(curator);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/curator/run",
      payload: { sync: true, dryRun: true, triggerMode: "manual" },
    });
    expect(res.statusCode).toBe(200);
    expect(curator.run).toHaveBeenCalledWith({ sync: true, dryRun: true, triggerMode: "manual" });
  });

  it("POST /api/v1/curator/run accepts an empty body as proposal-only", async () => {
    const curator = makeMockCurator();
    app = await makeApp(curator);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/curator/run",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(curator.run).toHaveBeenCalledWith({});
  });

  it("POST /api/v1/curator/run rejects dryRun: false", async () => {
    const curator = makeMockCurator();
    app = await makeApp(curator);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/curator/run",
      payload: { dryRun: false },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/proposal-only/i) });
    expect(curator.run).not.toHaveBeenCalled();
  });
});
