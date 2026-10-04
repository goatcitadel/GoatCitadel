import { describe, expect, it } from "vitest";
import {
  computeCoverage,
  domainOfUrl,
  isRouteKey,
  splitRouteKey,
  toRouteKey,
  trackedRouteKeys,
  type RouteManifest,
} from "./routes";

const MANIFEST: RouteManifest = {
  items: [
    { method: "GET", url: "/api/v1/workspaces", accessClass: "operator", tracked: true },
    { method: "GET", url: "/api/v1/workspaces", accessClass: "operator", tracked: true },
    { method: "HEAD", url: "/api/v1/workspaces", tracked: true },
    { method: "post", url: "/api/v1/chat/sessions", accessClass: "operator", tracked: true },
    { method: "GET", url: "/health", tracked: false },
  ],
};

describe("route keys", () => {
  it("builds keys only for supported methods", () => {
    expect(toRouteKey("post", "/api/v1/chat/sessions")).toBe("POST /api/v1/chat/sessions");
    expect(toRouteKey("HEAD", "/api/v1/workspaces")).toBeUndefined();
    expect(isRouteKey("GET /api/v1/chat/sessions/:sessionId/status")).toBe(true);
    expect(isRouteKey("GET api/v1/missing-slash")).toBe(false);
    expect(splitRouteKey("PATCH /api/v1/memory/items/:itemId")).toEqual({
      method: "PATCH",
      url: "/api/v1/memory/items/:itemId",
    });
  });

  it("lists unique tracked keys in order", () => {
    expect(trackedRouteKeys(MANIFEST)).toEqual(["GET /api/v1/workspaces", "POST /api/v1/chat/sessions"]);
  });

  it("derives the area from the URL", () => {
    expect(domainOfUrl("/api/v1/chat/sessions")).toBe("chat");
    expect(domainOfUrl("/health")).toBe("health");
    expect(domainOfUrl("/")).toBe("root");
  });
});

describe("computeCoverage", () => {
  it("reports unavailable coverage when the route list is missing", () => {
    expect(computeCoverage(undefined, [])).toBeUndefined();
  });

  it("counts claimed routes and flags stale /api/v1 claims", () => {
    const report = computeCoverage(trackedRouteKeys(MANIFEST), [
      { id: "chat.lifecycle", routes: ["POST /api/v1/chat/sessions", "POST /api/v1/chat/removed"] },
      { id: "health.gateway", routes: ["GET /health"] },
    ]);
    expect(report).toEqual({
      total: 2,
      covered: 1,
      uncovered: ["GET /api/v1/workspaces"],
      staleClaims: [{ checkId: "chat.lifecycle", route: "POST /api/v1/chat/removed" }],
    });
  });
});
