import { describe, expect, it } from "vitest";
import {
  buildShellSwitchUrl,
  classicFallbackPath,
  SHELL_PREFERENCE_KEY,
  resolveShellPreference,
  writeShellPreference,
} from "./shell-preference";
import { buildClassicOwnerUrl } from "./app/classic-owner-url";
import { resolveCockpitCompatibility } from "./cockpit/app/cockpit-compatibility";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    values,
  };
}

describe("shell preference", () => {
  it("keeps the saved cockpit preference during a temporary Classic owner visit and reload", () => {
    const storage = memoryStorage({ [SHELL_PREFERENCE_KEY]: "cockpit" });
    const target = new URL(
      buildClassicOwnerUrl("/ops/approvals?approvalId=exact&shell=classic#preview"),
      "http://localhost:5173",
    );
    expect(target.searchParams.get("approvalId")).toBe("exact");
    expect(target.hash).toBe("#preview");
    expect(resolveShellPreference({ search: target.search, storage })).toBe("classic");
    expect(resolveShellPreference({ search: target.search, storage })).toBe("classic");
    expect(storage.values.get(SHELL_PREFERENCE_KEY)).toBe("cockpit");
    expect(resolveShellPreference({ search: "", storage })).toBe("cockpit");
    const explicitSwitch = new URL(buildShellSwitchUrl(target.href, "classic"));
    expect(explicitSwitch.searchParams.has("shellScope")).toBe(false);
    expect(resolveShellPreference({ search: explicitSwitch.search, storage })).toBe("classic");
    expect(storage.values.get(SHELL_PREFERENCE_KEY)).toBe("classic");
  });

  it("defaults to cockpit and rejects unknown stored values", () => {
    expect(resolveShellPreference({ search: "", storage: null })).toBe("cockpit");
    expect(resolveShellPreference({ search: "", storage: memoryStorage() })).toBe("cockpit");
    expect(
      resolveShellPreference({
        search: "?shell=unknown",
        storage: memoryStorage({ [SHELL_PREFERENCE_KEY]: "unknown" }),
      }),
    ).toBe("cockpit");
  });

  it.each(["classic", "cockpit"] as const)("preserves an explicit stored %s choice", (shell) => {
    expect(resolveShellPreference({ search: "", storage: memoryStorage({ [SHELL_PREFERENCE_KEY]: shell }) })).toBe(
      shell,
    );
  });

  it("persists an explicit classic rollback override", () => {
    const storage = memoryStorage({ [SHELL_PREFERENCE_KEY]: "cockpit" });
    expect(resolveShellPreference({ search: "?shell=classic", storage })).toBe("classic");
    expect(storage.values.get(SHELL_PREFERENCE_KEY)).toBe("classic");
    expect(resolveShellPreference({ search: "", storage })).toBe("classic");
  });

  it("uses and persists a valid URL override", () => {
    const storage = memoryStorage({ [SHELL_PREFERENCE_KEY]: "classic" });
    expect(resolveShellPreference({ search: "?shell=cockpit", storage })).toBe("cockpit");
    expect(storage.values.get(SHELL_PREFERENCE_KEY)).toBe("cockpit");
    expect(resolveShellPreference({ search: "?shell=unknown", storage })).toBe("cockpit");
  });

  it("works when storage is unavailable", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(resolveShellPreference({ search: "?shell=cockpit", storage: broken })).toBe("cockpit");
    expect(resolveShellPreference({ search: "", storage: broken })).toBe("cockpit");
    expect(() => writeShellPreference("classic", broken)).not.toThrow();
  });

  it("maps cockpit-only routes to classic rollback surfaces", () => {
    expect(classicFallbackPath("/inbox")).toBe("/ops/approvals");
    expect(classicFallbackPath("/work/runs/example")).toBe("/ops/kanban");
    expect(classicFallbackPath("/system")).toBe("/ops/runtime");
    expect(classicFallbackPath("/system/spend")).toBe("/ops/costs");
    expect(classicFallbackPath("/settings/models")).toBe("/settings/onboarding");
    expect(classicFallbackPath("/settings/connections")).toBe("/settings/channels");
    expect(classicFallbackPath("/settings/safety")).toBe("/settings/permissions");
    expect(classicFallbackPath("/settings/citadel")).toBe("/library/citadel-overview");
    expect(classicFallbackPath("/settings/advanced")).toBe("/settings/runtime");
    expect(classicFallbackPath("/__gallery")).toBe("/settings/general");
    expect(classicFallbackPath("/library/skills")).toBe("/library/skills");
  });

  it("lands each ported System, Work and Projects view on its own Classic owner", () => {
    expect(classicFallbackPath("/system/dashboards")).toBe("/ops/boards");
    expect(classicFallbackPath("/system/dashboards/board%2F1")).toBe("/ops/boards");
    expect(classicFallbackPath("/system/browser-sessions")).toBe("/ops/sessions?view=browser-sessions");
    expect(classicFallbackPath("/system/improvement")).toBe("/ops/improvement");
    expect(classicFallbackPath("/system/health")).toBe("/ops/runtime");
    expect(classicFallbackPath("/work/schedules")).toBe("/ops/schedules");
    expect(classicFallbackPath("/work")).toBe("/ops/kanban");
    expect(classicFallbackPath("/chat/projects")).toBe("/projects");
    expect(classicFallbackPath("/chat/projects/p%2Fone")).toBe("/projects?projectId=p%2Fone");
    expect(classicFallbackPath("/chat/projects/%E0%A4%A")).toBe("/projects");
  });

  it("keeps the browser-session view and record through Classic rollback", () => {
    const target = new URL(
      buildShellSwitchUrl("http://localhost/system/browser-sessions?sessionId=s1#grants", "classic"),
    );
    expect(target.pathname).toBe("/ops/sessions");
    expect(target.searchParams.get("view")).toBe("browser-sessions");
    expect(target.searchParams.get("sessionId")).toBe("s1");
    expect(target.searchParams.get("shell")).toBe("classic");
    expect(target.hash).toBe("#grants");
  });

  // The Classic rollback table and the Cockpit compatibility table must agree on each owner, so a
  // "Switch to classic" followed by its reverse mapping returns to the same Cockpit view.
  it.each([
    ["/inbox", "/inbox"],
    ["/work/schedules", "/work/schedules"],
    ["/system", "/system/runtime"],
    ["/system/activity", "/system/activity"],
    ["/system/quality", "/system/quality"],
    ["/system/diagnostics", "/system/diagnostics"],
    ["/system/spend", "/system/spend"],
    ["/system/spend/details", "/system/spend/details"],
    ["/system/runtime/workers", "/system/runtime/workers"],
    ["/system/improvement", "/system/improvement"],
    ["/system/dashboards", "/system/dashboards"],
    ["/system/dashboards/board%2F1", "/system/dashboards"],
    ["/system/browser-sessions", "/system/browser-sessions"],
    ["/chat/projects", "/chat/projects"],
    ["/chat/projects/p%2Fone", "/chat/projects/p%2Fone"],
  ])("round-trips %s through its Classic rollback owner", (cockpit, native) => {
    const classic = new URL(buildShellSwitchUrl(`http://localhost${cockpit}?workspaceId=w#keep`, "classic"));
    classic.searchParams.delete("shell");
    const resolution = resolveCockpitCompatibility(classic.pathname + classic.search + classic.hash);
    expect(resolution.kind).toBe("native");
    const resolved = new URL((resolution as { href: string }).href, "http://cockpit.invalid");
    expect(resolved.pathname).toBe(native);
    expect(resolved.searchParams.get("workspaceId")).toBe("w");
    expect(resolved.hash).toBe("#keep");
  });

  it("keeps the selected conversation when returning to the current Chat", () => {
    const target = new URL(buildShellSwitchUrl("http://localhost:5175/chat?shell=cockpit", "classic", "thread-2"));
    expect(target.pathname).toBe("/chat");
    expect(target.searchParams.get("sessionId")).toBe("thread-2");
    expect(target.searchParams.get("shell")).toBe("classic");
  });
});

it.each(["activity", "quality", "diagnostics"])("preserves the %s view and record through Classic rollback", (view) => {
  const target = new URL(
    buildShellSwitchUrl(`http://localhost/system/${view}?workspaceId=w&runId=keep#record`, "classic"),
  );
  expect(target.pathname).toBe(`/ops/${view}`);
  expect(target.searchParams.get("workspaceId")).toBe("w");
  expect(target.searchParams.get("runId")).toBe("keep");
  expect(target.hash).toBe("#record");
});

it.each(["/system/spend", "/system/spend/details"])(
  "preserves exact Costs scope through explicit Classic and Cockpit switches from %s",
  (pathname) => {
    const storage = memoryStorage({ [SHELL_PREFERENCE_KEY]: "cockpit" });
    const carried =
      "?workspaceId=w%2Fone&citadelId=c&sessionId=s%2Fone&runId=r%3Aone&keep=one&keep=two&shellScope=visit";
    const classic = new URL(buildShellSwitchUrl("http://localhost" + pathname + carried + "#coverage", "classic"));
    expect(classic.pathname).toBe("/ops/costs");
    expect(classic.searchParams.get("cockpitReturnView")).toBe(pathname === "/system/spend" ? "spend-overview" : null);
    expect(classic.searchParams.has("shellScope")).toBe(false);
    expect(resolveShellPreference({ search: classic.search, storage })).toBe("classic");
    expect(storage.values.get(SHELL_PREFERENCE_KEY)).toBe("classic");
    const cockpit = new URL(buildShellSwitchUrl(classic.href, "cockpit"));
    expect(resolveShellPreference({ search: cockpit.search, storage })).toBe("cockpit");
    expect(storage.values.get(SHELL_PREFERENCE_KEY)).toBe("cockpit");
    const result = resolveCockpitCompatibility(cockpit.pathname + cockpit.search + cockpit.hash);
    expect(result.kind).toBe("native");
    if (result.kind !== "native") throw new Error("Native Costs destination unavailable");
    const target = new URL(result.href, "http://localhost");
    expect(target.pathname).toBe(pathname);
    expect(target.searchParams.get("workspaceId")).toBe("w/one");
    expect(target.searchParams.get("citadelId")).toBe("c");
    expect(target.searchParams.get("sessionId")).toBe("s/one");
    expect(target.searchParams.get("runId")).toBe("r:one");
    expect(target.searchParams.getAll("keep")).toEqual(["one", "two"]);
    expect(target.searchParams.has("cockpitReturnView")).toBe(false);
    expect(target.searchParams.get("shell")).toBe("cockpit");
    expect(target.hash).toBe("#coverage");
  },
);

it("does not carry a stale overview return when the operator explicitly rolls back full Costs details", () => {
  const target = new URL(
    buildShellSwitchUrl(
      "http://localhost/system/spend/details?cockpitReturnView=spend-overview&keep=one&keep=two#evidence",
      "classic",
    ),
  );
  expect(target.pathname).toBe("/ops/costs");
  expect(target.searchParams.has("cockpitReturnView")).toBe(false);
  expect(target.searchParams.getAll("keep")).toEqual(["one", "two"]);
  expect(target.hash).toBe("#evidence");
});

it("rolls native worker inspection back to its exact Classic worker owner without losing record or history context", () => {
  const carried =
    "?workerId=worker%2Fone&assignmentId=assignment%3Aone&workspaceId=w%2Fone&citadelId=c&sessionId=s&runId=r&keep=one&keep=two&shellScope=visit";
  const classic = new URL(
    buildShellSwitchUrl("http://localhost/system/runtime/workers" + carried + "#record", "classic"),
  );
  expect(classicFallbackPath("/system/runtime/workers")).toBe("/ops/workers");
  expect(classic.pathname).toBe("/ops/workers");
  expect(classic.searchParams.get("shell")).toBe("classic");
  expect(classic.searchParams.has("shellScope")).toBe(false);
  const cockpit = new URL(buildShellSwitchUrl(classic.href, "cockpit"));
  const result = resolveCockpitCompatibility(cockpit.pathname + cockpit.search + cockpit.hash);
  expect(result.kind).toBe("native");
  if (result.kind !== "native") throw new Error("Native worker destination unavailable");
  const target = new URL(result.href, "http://localhost");
  expect(target.pathname).toBe("/system/runtime/workers");
  for (const [key, value] of [
    ["workerId", "worker/one"],
    ["assignmentId", "assignment:one"],
    ["workspaceId", "w/one"],
    ["citadelId", "c"],
    ["sessionId", "s"],
    ["runId", "r"],
  ] as const)
    expect(target.searchParams.get(key)).toBe(value);
  expect(target.searchParams.getAll("keep")).toEqual(["one", "two"]);
  expect(target.hash).toBe("#record");
});

it.each([
  ["unknown"],
  [""],
  ["spend-overview", "details"],
  ["spend-overview", "spend-overview"],
  ["details", "spend-overview"],
  ["https://elsewhere.invalid"],
])("retains unsupported or ambiguous Costs return markers through an explicit details rollback: %j", (...markers) => {
  const params = new URLSearchParams("workspaceId=w%2Fone&keep=one&keep=two");
  for (const marker of markers) params.append("cockpitReturnView", marker);
  const classic = new URL(
    buildShellSwitchUrl("http://localhost/system/spend/details?" + params + "#evidence", "classic"),
  );
  expect(classic.pathname).toBe("/ops/costs");
  expect(classic.searchParams.getAll("cockpitReturnView")).toEqual(markers);
  expect(classic.searchParams.getAll("keep")).toEqual(["one", "two"]);
  expect(classic.searchParams.get("workspaceId")).toBe("w/one");
  expect(classic.hash).toBe("#evidence");
  const cockpit = new URL(buildShellSwitchUrl(classic.href, "cockpit"));
  expect(cockpit.searchParams.getAll("cockpitReturnView")).toEqual(markers);
  const expectedSearch = cockpit.search;
  const result = resolveCockpitCompatibility(cockpit.pathname + expectedSearch + cockpit.hash);
  expect(result).toEqual({ kind: "native", href: "/system/spend/details" + expectedSearch + "#evidence" });
});
