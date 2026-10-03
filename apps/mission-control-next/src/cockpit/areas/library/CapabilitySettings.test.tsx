// @vitest-environment happy-dom
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CapabilityCatalogEntry, SkillListItem } from "@goatcitadel/contracts";
import { fetchSkills, updateSkillState } from "@goatcitadel/mission-control-shared/api/skills";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilitySettings } from "./CapabilitySettings";
import { __resetCapabilitySkillAttemptsForTests } from "./use-capability-skill-state";

vi.mock("@goatcitadel/mission-control-shared/api/skills", () => ({ fetchSkills: vi.fn(), updateSkillState: vi.fn() }));
const scope = vi.hoisted(() => ({ activeWorkspaceId: "workspace-a", activeCitadelId: "citadel-a" }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => scope }));
const switchShell = vi.hoisted(() =>
  vi.fn<typeof import("../../../shell-preference").switchShell>(async () => "cancelled"),
);
vi.mock("../../../shell-preference", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shell-preference")>()),
  switchShell,
}));

const item: CapabilityCatalogEntry = {
  capabilityId: "skill:review",
  kind: "skill",
  category: "built_in",
  title: "Review",
  summary: "Review code",
  callable: true,
  skillId: "review",
};
const skill: SkillListItem = {
  skillId: "review",
  name: "Review",
  source: "bundled",
  dir: "skills/review",
  declaredTools: [],
  requires: [],
  keywords: [],
  instructionBody: "Review code",
  mtime: "2026-09-28T00:00:00.000Z",
  revision: 4,
  state: "enabled",
};
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  __resetCapabilitySkillAttemptsForTests();
  scope.activeWorkspaceId = "workspace-a";
  scope.activeCitadelId = "citadel-a";
  switchShell.mockClear();
  window.history.replaceState(null, "", "/library?shell=cockpit");
  vi.mocked(fetchSkills).mockReset();
  vi.mocked(updateSkillState).mockReset();
  vi.mocked(fetchSkills).mockResolvedValue({ items: [skill] });
  vi.mocked(updateSkillState).mockResolvedValue({
    pendingApproval: {
      approvalId: "approval-7",
      status: "pending",
      kind: "skill.lifecycle",
      action: "skill_state_set",
      subjectKind: "skill",
      subjectId: "review",
      requestSha256: "a".repeat(64),
      expectedStateSha256: "b".repeat(64),
      createdAt: "2026-09-28T00:00:00.000Z",
      replayed: false,
      skillIds: ["review"],
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderSettings(onRefresh = vi.fn<() => void>(), selectedItem = item, selectedSkill = skill, strict = false) {
  const view = (
    <CockpitNavigationProvider>
      <CapabilitySettings item={selectedItem} skillsKnown skill={selectedSkill} onRefresh={onRefresh} />
    </CockpitNavigationProvider>
  );
  act(() => root.render(strict ? <StrictMode>{view}</StrictMode> : view));
  return onRefresh;
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((entry) => entry.textContent === label);
  if (!found) throw new Error(`Missing ${label} button`);
  return found;
}

describe("Library skill state requests", () => {
  it("opens native tool controls in the current document and preserves scope", async () => {
    renderSettings(vi.fn(), { ...item, capabilityId: "tool:shell.run", kind: "tool", toolName: "shell.run" });
    const link = container.querySelector<HTMLAnchorElement>("a")!;
    expect(link.getAttribute("href")).toBe("/settings/safety?shell=cockpit#approval-mode");
    const documentBefore = window.document;
    await act(async () => link.click());
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      "/settings/safety?shell=cockpit#approval-mode",
    );
    expect(window.document).toBe(documentBefore);
    expect(scope).toEqual({ activeWorkspaceId: "workspace-a", activeCitadelId: "citadel-a" });
    expect(switchShell).not.toHaveBeenCalled();
    expect(updateSkillState).not.toHaveBeenCalled();
  });

  it("uses a scoped shared classic handoff without erasing an uncertain skill attempt", async () => {
    vi.mocked(updateSkillState).mockRejectedValue(new Error("Connection lost"));
    renderSettings();
    await act(async () => button("Request disable").click());
    await act(async () => button("Confirm request").click());
    renderSettings(vi.fn(), { ...item, kind: "proposal", proposalId: "proposal-a" });
    const link = container.querySelector<HTMLAnchorElement>("a")!;
    expect(link.getAttribute("href")).toBe("/library/curator?shell=classic&shellScope=visit");
    await act(async () => link.click());
    expect(switchShell).toHaveBeenCalledExactlyOnceWith(
      "classic",
      expect.objectContaining({
        href: "/library/curator?shell=classic&shellScope=visit",
        isCurrent: expect.any(Function),
        signal: expect.any(AbortSignal),
      }),
    );
    const [, options] = switchShell.mock.calls[0]!;
    expect(options.isCurrent()).toBe(true);
    scope.activeCitadelId = "citadel-b";
    renderSettings(vi.fn(), { ...item, kind: "proposal", proposalId: "proposal-a" });
    expect(options.isCurrent()).toBe(false);
    act(() => root.render(null));
    renderSettings();
    expect(container.textContent).toContain("Request outcome is uncertain");
    expect(button("Request disable").disabled).toBe(true);
    expect(updateSkillState).toHaveBeenCalledOnce();
  });

  it("confirms, rereads the exact revision, and reports a pending approval without claiming a state change", async () => {
    const onRefresh = renderSettings();
    await act(async () => button("Request disable").click());
    expect(updateSkillState).not.toHaveBeenCalled();
    await act(async () => button("Confirm request").click());
    expect(fetchSkills).toHaveBeenCalledOnce();
    expect(updateSkillState).toHaveBeenCalledWith("review", { expectedRevision: 4, state: "disabled" });
    expect(container.textContent).toContain("Approval requested");
    expect(container.querySelector("details")?.textContent).toContain("approval-7");
    expect(container.textContent).toContain("remains Enabled until the decision and follow-on effect complete");
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("does not request a change after the Gateway skill revision changes", async () => {
    vi.mocked(fetchSkills).mockResolvedValue({ items: [{ ...skill, revision: 5 }] });
    const onRefresh = renderSettings();
    await act(async () => button("Request pause").click());
    await act(async () => button("Confirm request").click());
    expect(updateSkillState).not.toHaveBeenCalled();
    expect(container.textContent).toContain("This skill changed in Gateway");
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("locks requests after an uncertain mutation response", async () => {
    vi.mocked(updateSkillState).mockRejectedValue(new Error("Connection lost"));
    renderSettings();
    await act(async () => button("Request disable").click());
    await act(async () => button("Confirm request").click());
    expect(updateSkillState).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Request outcome is uncertain");
    expect(button("Request disable").disabled).toBe(true);
    expect(button("Request pause").disabled).toBe(true);
  });

  it.each(["unmount", "selection", "workspace", "workspace-away-and-back", "revision-away-and-back"])(
    "cancels a delayed preflight after %s",
    async (transition) => {
      const ownerRead = deferred<Awaited<ReturnType<typeof fetchSkills>>>();
      vi.mocked(fetchSkills).mockReturnValue(ownerRead.promise);
      const onRefresh = renderSettings();
      await act(async () => button("Request disable").click());
      await act(async () => button("Confirm request").click());
      if (transition === "unmount") act(() => root.render(null));
      if (transition === "selection") {
        renderSettings(
          onRefresh,
          { ...item, capabilityId: "skill:other", skillId: "other" },
          { ...skill, skillId: "other" },
        );
      }
      if (transition.startsWith("workspace")) {
        scope.activeWorkspaceId = "workspace-b";
        renderSettings(onRefresh);
        if (transition.endsWith("back")) {
          scope.activeWorkspaceId = "workspace-a";
          renderSettings(onRefresh);
        }
      }
      if (transition.startsWith("revision")) {
        renderSettings(onRefresh, item, { ...skill, revision: 5 });
        renderSettings(onRefresh);
      }
      await act(async () => ownerRead.resolve({ items: [skill] }));
      expect(updateSkillState).not.toHaveBeenCalled();
      expect(onRefresh).not.toHaveBeenCalled();
      renderSettings(onRefresh);
      expect(button("Request disable").disabled).toBe(false);
      expect(container.textContent).not.toContain("Confirm request");
    },
  );

  it("retains a dispatched request lock on remount and records its late acknowledgement", async () => {
    const ownerWrite = deferred<Awaited<ReturnType<typeof updateSkillState>>>();
    const receipt = await vi.mocked(updateSkillState).getMockImplementation()!("review", {
      expectedRevision: 4,
      state: "disabled",
    });
    vi.mocked(updateSkillState).mockReturnValue(ownerWrite.promise);
    const onRefresh = renderSettings();
    await act(async () => button("Request disable").click());
    await act(async () => button("Confirm request").click());
    act(() => root.render(null));
    renderSettings(onRefresh);
    expect(button("Request disable").disabled).toBe(true);
    await act(async () => ownerWrite.resolve(receipt));
    expect(updateSkillState).toHaveBeenCalledOnce();
    expect(onRefresh).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Approval requested");
    expect(button("Request disable").disabled).toBe(false);
  });

  it("retains a lost response lock across remount and workspace navigation", async () => {
    const ownerWrite = deferred<Awaited<ReturnType<typeof updateSkillState>>>();
    vi.mocked(updateSkillState).mockReturnValue(ownerWrite.promise);
    const onRefresh = renderSettings();
    await act(async () => button("Request disable").click());
    await act(async () => button("Confirm request").click());
    act(() => root.render(null));
    await act(async () => ownerWrite.reject(new Error("Connection lost")));
    scope.activeWorkspaceId = "workspace-b";
    renderSettings(onRefresh);
    expect(container.textContent).toContain("Request outcome is uncertain");
    expect(button("Request disable").disabled).toBe(true);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(updateSkillState).toHaveBeenCalledOnce();
  });

  it.each(["foreign", "wrong-action", "invalid-hash", "foreign-no-op"])(
    "locks an unbound %s receipt",
    async (variant) => {
      const outcome = await vi.mocked(updateSkillState).getMockImplementation()!("review", {
        expectedRevision: 4,
        state: "disabled",
      });
      if (!outcome.pendingApproval) throw new Error("Expected approval fixture");
      if (variant === "foreign") outcome.pendingApproval.subjectId = "other";
      if (variant === "wrong-action") outcome.pendingApproval.action = "skill_state_bulk_set";
      if (variant === "invalid-hash") outcome.pendingApproval.requestSha256 = "missing";
      vi.mocked(updateSkillState).mockResolvedValue(
        variant === "foreign-no-op"
          ? {
              pendingApproval: null,
              noMutationRequired: true,
              skillState: { skillId: "other", revision: 4, state: "disabled", updatedAt: skill.mtime },
            }
          : outcome,
      );
      const onRefresh = renderSettings();
      await act(async () => button("Request disable").click());
      await act(async () => button("Confirm request").click());
      expect(onRefresh).not.toHaveBeenCalled();
      expect(container.textContent).toContain("Request outcome is uncertain");
      expect(button("Request disable").disabled).toBe(true);
    },
  );

  it("preserves a recorded acknowledgement when the refresh callback throws", async () => {
    const onRefresh = vi.fn<() => void>(() => {
      throw new Error("Refresh failed");
    });
    renderSettings(onRefresh);
    await act(async () => button("Request disable").click());
    await act(async () => button("Confirm request").click());
    expect(container.textContent).toContain("Approval requested");
    expect(container.textContent).toContain("Library could not refresh");
    expect(container.textContent).not.toContain("Request outcome is uncertain");
    expect(button("Request disable").disabled).toBe(false);
  });

  it("does not retain a transport lock after a verified receipt and clears old copy on owner advancement", async () => {
    const onRefresh = renderSettings();
    await act(async () => button("Request disable").click());
    await act(async () => button("Confirm request").click());
    expect(button("Request pause").disabled).toBe(false);
    renderSettings(onRefresh, item, { ...skill, revision: 5, state: "disabled" });
    expect(button("Request enable").disabled).toBe(false);
    expect(container.textContent).not.toContain("Approval requested");
  });

  it("keeps an explicit review functional after StrictMode lifecycle replay", async () => {
    renderSettings(vi.fn<() => void>(), item, skill, true);
    await act(async () => button("Request disable").click());
    await act(async () => button("Confirm request").click());
    expect(updateSkillState).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Approval requested");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
