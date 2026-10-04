import { describe, expect, it } from "vitest";
import { pass } from "../runner/assert";
import { INITIAL_RUN_STATE, countStatuses, runReducer, type RunEvent } from "../runner/state";
import type { CheckDef } from "../runner/types";
import {
  DEFAULT_FILTERS,
  countForFilter,
  filterChecks,
  groupRoutesByDomain,
  summarizeDomains,
  toggleTier,
} from "./filters";

const CHECKS: CheckDef[] = [
  {
    id: "a",
    kind: "probe",
    domain: "chat",
    title: "Session lifecycle",
    tier: "mutate",
    routes: ["POST /api/v1/chat/sessions"],
    run: async () => pass("ok"),
  },
  {
    id: "b",
    kind: "auto",
    domain: "memory",
    title: "memory/items",
    tier: "read",
    routes: ["GET /api/v1/memory/items"],
    run: async () => pass("ok"),
  },
  {
    id: "c",
    kind: "probe",
    domain: "chat",
    title: "Cancel turn",
    tier: "mutate",
    routes: ["POST /api/v1/chat/sessions/:sessionId/turns/:turnId/cancel"],
    run: async () => pass("ok"),
  },
];

const EVENTS: RunEvent[] = [
  { type: "check-finished", checkId: "a", status: "pass", summary: "ok", durationMs: 1 },
  { type: "check-finished", checkId: "c", status: "fail", summary: "bad", durationMs: 1 },
];

const STATE = EVENTS.reduce(runReducer, INITIAL_RUN_STATE);

describe("filterChecks", () => {
  it("filters by area, tier, status, and search text across titles and routes", () => {
    expect(filterChecks(CHECKS, STATE, DEFAULT_FILTERS).map((check) => check.id)).toEqual(["a", "b", "c"]);
    expect(filterChecks(CHECKS, STATE, { ...DEFAULT_FILTERS, domain: "chat" }).map((check) => check.id)).toEqual([
      "a",
      "c",
    ]);
    expect(
      filterChecks(CHECKS, STATE, { ...DEFAULT_FILTERS, tiers: new Set(["read"]) }).map((check) => check.id),
    ).toEqual(["b"]);
    expect(filterChecks(CHECKS, STATE, { ...DEFAULT_FILTERS, status: "failing" }).map((check) => check.id)).toEqual([
      "c",
    ]);
    expect(filterChecks(CHECKS, STATE, { ...DEFAULT_FILTERS, status: "not-run" }).map((check) => check.id)).toEqual([
      "b",
    ]);
    expect(filterChecks(CHECKS, STATE, { ...DEFAULT_FILTERS, query: "/CANCEL" }).map((check) => check.id)).toEqual([
      "c",
    ]);
  });
});

describe("filter helpers", () => {
  it("counts filter matches, toggles tiers immutably, and summarizes areas", () => {
    const counts = countStatuses(
      STATE,
      CHECKS.map((check) => check.id),
    );
    expect(countForFilter(counts, "failing")).toBe(1);
    expect(countForFilter(counts, "not-run")).toBe(1);
    const original = new Set<"read">(["read"]);
    expect([...toggleTier(original, "read")]).toEqual([]);
    expect([...original]).toEqual(["read"]);
    expect(summarizeDomains(CHECKS, STATE, (domain) => domain.toUpperCase())).toEqual([
      { domain: "chat", label: "CHAT", total: 2, passed: 1, failing: 1 },
      { domain: "memory", label: "MEMORY", total: 1, passed: 0, failing: 0 },
    ]);
  });

  it("groups uncovered routes by area", () => {
    expect(
      groupRoutesByDomain(["GET /api/v1/memory/items", "POST /api/v1/chat/sessions", "GET /api/v1/chat/sessions"]),
    ).toEqual([
      ["chat", ["POST /api/v1/chat/sessions", "GET /api/v1/chat/sessions"]],
      ["memory", ["GET /api/v1/memory/items"]],
    ]);
  });
});
