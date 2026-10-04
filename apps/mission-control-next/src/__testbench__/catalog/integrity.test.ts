// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { isRouteKey, splitRouteKey } from "../runner/routes";
import { DOMAIN_LABELS, domainLabel } from "./domains";
import { HAND_WRITTEN_CHECKS } from "./index";

const HOST_ROUTE_PATTERNS: readonly RegExp[] = [
  /^POST \/api\/v1\/code-mode\//,
  /^POST \/api\/v1\/chat\/tools\/approve$/,
];

describe("hand-written catalog integrity", () => {
  it("uses unique ids", () => {
    const ids = HAND_WRITTEN_CHECKS.map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares at least one well-formed route per check", () => {
    for (const check of HAND_WRITTEN_CHECKS) {
      expect(check.routes.length, check.id).toBeGreaterThan(0);
      for (const route of check.routes) {
        expect(isRouteKey(route), `${check.id}: ${route}`).toBe(true);
      }
    }
  });

  it("never tiers a check that claims a non-GET route as read", () => {
    for (const check of HAND_WRITTEN_CHECKS) {
      if (check.routes.some((route) => splitRouteKey(route).method !== "GET")) {
        expect(check.tier, check.id).not.toBe("read");
      }
    }
  });

  it("allowlists only external checks for the real gateway", () => {
    for (const check of HAND_WRITTEN_CHECKS.filter((candidate) => candidate.realSafe === true)) {
      expect(check.tier, check.id).toBe("external");
    }
  });

  it("tiers every check that can run code on the host as host", () => {
    for (const check of HAND_WRITTEN_CHECKS) {
      if (check.routes.some((route) => HOST_ROUTE_PATTERNS.some((pattern) => pattern.test(route)))) {
        expect(check.tier, check.id).toBe("host");
      }
    }
  });

  it("declares step titles for every journey", () => {
    for (const check of HAND_WRITTEN_CHECKS.filter((candidate) => candidate.kind === "journey")) {
      expect(check.steps?.length ?? 0, check.id).toBeGreaterThanOrEqual(2);
    }
  });

  it("labels every hand-written area and title-cases unknown ones", () => {
    for (const check of HAND_WRITTEN_CHECKS) {
      expect(DOMAIN_LABELS[check.domain], check.domain).toBeDefined();
    }
    expect(domainLabel("prompt-packs")).toBe("Prompt packs");
    expect(domainLabel("llm")).toBe("Providers");
  });
});
