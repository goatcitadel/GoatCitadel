import { beforeEach, describe, expect, it, vi } from "vitest";
import { pass } from "../runner/assert";
import type { RouteManifest } from "../runner/routes";
import type { CheckDef } from "../runner/types";
import { makeTestContext } from "../test-support/context";
import { findExclusion } from "./auto-probe-exclusions";
import { buildAutoProbes } from "./auto-probes";

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ request: requestMock }));

const MANIFEST: RouteManifest = {
  items: [
    { method: "GET", url: "/api/v1/workspaces", accessClass: "operator", tracked: true },
    { method: "GET", url: "/api/v1/workspaces", accessClass: "operator", tracked: true },
    { method: "GET", url: "/api/v1/workspaces/:workspaceId", accessClass: "operator", tracked: true },
    { method: "POST", url: "/api/v1/workspaces", accessClass: "operator", tracked: true },
    { method: "GET", url: "/api/v1/events/feed", accessClass: "sse-read", tracked: true },
    { method: "GET", url: "/api/v1/dev/verification/status", accessClass: "operator", tracked: true },
    { method: "GET", url: "/api/v1/llm/config", accessClass: "operator", tracked: true },
    { method: "GET", url: "/api/v1/memory/items", accessClass: "operator", tracked: true },
    { method: "GET", url: "/health", tracked: false },
  ],
};

const CLAIMING: CheckDef = {
  id: "memory.lifecycle",
  kind: "journey",
  domain: "memory",
  title: "Memory lifecycle",
  tier: "mutate",
  routes: ["GET /api/v1/memory/items"],
  run: async () => pass("ok"),
};

beforeEach(() => {
  requestMock.mockReset();
});

describe("buildAutoProbes", () => {
  it("probes unclaimed parameterless GET routes in the sandbox", () => {
    expect(buildAutoProbes(MANIFEST, [CLAIMING], "sandbox").map((probe) => probe.id)).toEqual([
      "auto:GET /api/v1/llm/config",
      "auto:GET /api/v1/workspaces",
    ]);
  });

  it("skips network-reaching areas on the real gateway", () => {
    expect(buildAutoProbes(MANIFEST, [CLAIMING], "real").map((probe) => probe.id)).toEqual([
      "auto:GET /api/v1/workspaces",
    ]);
  });

  it("generates read probes that pass on a JSON answer", async () => {
    const [probe] = buildAutoProbes(MANIFEST, [CLAIMING], "real");
    expect(probe).toMatchObject({ kind: "auto", tier: "read", domain: "workspaces", title: "workspaces" });
    requestMock.mockResolvedValueOnce({ items: [] });
    const ctx = makeTestContext();
    await expect(probe?.run(ctx)).resolves.toMatchObject({
      status: "pass",
      summary: "Answered with JSON.",
    });
    expect(requestMock).toHaveBeenCalledWith("/api/v1/workspaces", { signal: ctx.signal });
  });

  it("passes a no-content answer", async () => {
    const [probe] = buildAutoProbes(MANIFEST, [CLAIMING], "real");
    requestMock.mockResolvedValueOnce(undefined);
    await expect(probe?.run(makeTestContext())).resolves.toMatchObject({
      summary: "Answered with no content.",
    });
  });
});

describe("findExclusion", () => {
  it("excludes documentation, downloads, streams, the remote model catalog, and dev endpoints", () => {
    expect(findExclusion("/api/v1/docs")?.reason).toContain("HTML");
    expect(findExclusion("/api/v1/admin/backups/export")?.reason).toContain("large payload");
    expect(findExclusion("/api/v1/events/stream")?.reason).toContain("Streams");
    expect(findExclusion("/api/v1/llm/models")?.reason).toContain("remote model catalog");
    expect(findExclusion("/api/v1/dev/diagnostics")?.reason).toContain("journeys");
    expect(findExclusion("/api/v1/workspaces")).toBeUndefined();
  });
});
