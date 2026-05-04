import { describe, expect, it } from "vitest";
import { buildAppHref, parseAppRoute } from "./route-model";
import { coerceLegacyHrefToNext, resolveRouteFromLocation } from "./legacy-route-adapter";

describe("legacy route adapter", () => {
  it("maps legacy work surface tabs into the new areas", () => {
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?tab=dashboard&surface=chat")).toBe("/chat");
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?tab=dashboard&surface=cowork")).toBe("/cowork");
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?tab=dashboard&surface=code")).toBe("/code");
  });

  it("maps bare legacy surface parameters into the new areas", () => {
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?surface=chat")).toBe("/chat");
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?surface=cowork")).toBe("/cowork");
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?surface=code")).toBe("/code");
  });

  it("maps legacy herd tabs into the cowork board", () => {
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?tab=herd-live")).toBe("/cowork/board");
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?tab=herd-lab")).toBe("/cowork/board");
  });

  it("maps legacy observe routes into library and ops destinations", () => {
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=observe&page=artifacts&tab=files")).toBe(
      "/library/files",
    );
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=observe&page=quality")).toBe(
      "/library/prompt-packs",
    );
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=observe&page=activity&tab=scheduler")).toBe(
      "/ops/schedules",
    );
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=observe&page=system")).toBe("/ops/runtime");
  });

  it("maps promptlab tabs into library prompt packs", () => {
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?tab=promptlab")).toBe("/library/prompt-packs");
  });

  it("maps legacy configure routes into settings and library homes", () => {
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=configure&page=settings&tab=providers")).toBe(
      "/settings/providers",
    );
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=configure&page=integrations&tab=mcp")).toBe(
      "/settings/mcp",
    );
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=configure&page=agents&tab=skills")).toBe(
      "/library/skills",
    );
    expect(coerceLegacyHrefToNext("http://goatcitadel.local/?space=configure&page=agents&tab=board")).toBe(
      "/cowork/board",
    );
  });

  it("preserves route ids while converting legacy search urls", () => {
    expect(
      coerceLegacyHrefToNext(
        "http://goatcitadel.local/?space=operate&page=surface&surface=chat&sessionId=s-1&turnId=t-2&artifactId=a-3",
      ),
    ).toBe("/chat?sessionId=s-1&turnId=t-2&artifactId=a-3");
  });
});

describe("mission-control-next route model", () => {
  it("parses path-based routes", () => {
    expect(parseAppRoute("http://goatcitadel.local/library/prompt-packs?view=benchmark")).toEqual({
      area: "library",
      section: "prompt-packs",
      view: "benchmark",
      sessionId: undefined,
      turnId: undefined,
      artifactId: undefined,
      approvalId: undefined,
      projectId: undefined,
      theme: undefined,
    });
  });

  it("builds stable hrefs", () => {
    expect(
      buildAppHref({
        area: "chat",
        sessionId: "session-9",
        turnId: "turn-4",
      }),
    ).toBe("/chat?sessionId=session-9&turnId=turn-4");
  });

  it("parses and builds project detail routes", () => {
    expect(parseAppRoute("http://goatcitadel.local/projects/Project-ABC")).toEqual({
      area: "projects",
      section: undefined,
      sessionId: undefined,
      turnId: undefined,
      artifactId: undefined,
      approvalId: undefined,
      projectId: "Project-ABC",
      theme: undefined,
      view: undefined,
    });
    expect(buildAppHref({ area: "projects", projectId: "Project-ABC" })).toBe("/projects/Project-ABC");
  });

  it("keeps malformed project path segments from crashing route parsing", () => {
    expect(parseAppRoute("http://goatcitadel.local/projects/Project-%").projectId).toBe("Project-%");
  });

  it("prefers legacy query parsing when old shell links are opened", () => {
    expect(resolveRouteFromLocation("http://goatcitadel.local/?tab=memory")).toEqual({
      area: "library",
      section: "memory",
      sessionId: undefined,
      turnId: undefined,
      artifactId: undefined,
      approvalId: undefined,
      projectId: undefined,
      theme: undefined,
      view: undefined,
    });
  });
});
