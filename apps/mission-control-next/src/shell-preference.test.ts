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
    const target = new URL(buildShellSwitchUrl("http://localhost/system/browser-sessions?sessionId=s1#grants", "classic"));
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
    ["/system", "/system"],
    ["/system/activity", "/system/activity"],
    ["/system/quality", "/system/quality"],
    ["/system/diagnostics", "/system/diagnostics"],
    ["/system/spend", "/system/spend"],
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
  const target = new URL(buildShellSwitchUrl(`http://localhost/system/${view}?workspaceId=w&runId=keep#record`, "classic"));
  expect(target.pathname).toBe(`/ops/${view}`);
  expect(target.searchParams.get("workspaceId")).toBe("w");
  expect(target.searchParams.get("runId")).toBe("keep");
  expect(target.hash).toBe("#record");
});
