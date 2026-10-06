// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CitadelRecord, WorkspaceRecord } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UiPreferencesProvider, useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import {
  beginChatSessionCreation,
  chatSessionCreationKey,
  readChatSessionCreation,
  resetChatSessionCreationForTests,
} from "@goatcitadel/mission-control-shared/state/chat-session-creation";
import { useSessionDraft, __resetSessionDraftsForTests } from "../../features/native-routes/library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "../../features/native-routes/library/use-form-dirty";
import { CockpitNavigationProvider } from "./CockpitNavigationProvider";
import { useCockpitScope } from "./use-cockpit-scope";
import { MobileTabBar } from "./MobileTabBar";
import { ScopeSwitcher } from "./ScopeSwitcher";

vi.unmock("vaul");
vi.mock("../data/use-operator-inbox", () => ({ useOperatorInbox: () => ({ data: undefined, isError: false }) }));
const mocks = vi.hoisted(() => ({
  installation: "http://scope.invalid",
  citadels: vi.fn<typeof import("@goatcitadel/mission-control-shared/api/citadels").listCitadels>(),
  currentCitadel:
    vi.fn<typeof import("@goatcitadel/mission-control-shared/api/citadels").getCitadelStructureSnapshot>(),
  workspaces: vi.fn<typeof import("@goatcitadel/mission-control-shared/api/workspaces").fetchWorkspaces>(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => mocks.installation,
}));
vi.mock("@goatcitadel/mission-control-shared/api/citadels", () => ({
  listCitadels: mocks.citadels,
  getCitadelStructureSnapshot: mocks.currentCitadel,
}));
vi.mock("@goatcitadel/mission-control-shared/api/workspaces", () => ({ fetchWorkspaces: mocks.workspaces }));
const citadel = (id: string): CitadelRecord => ({
  citadelId: id,
  revision: "a".repeat(64),
  name: id,
  slug: id,
  kind: "personal",
  lifecycleStatus: "active",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
});
const workspace = (id: string, citadelId = "cit-b"): WorkspaceRecord => ({
  workspaceId: id,
  citadelId,
  revision: 1,
  name: id,
  slug: id,
  lifecycleStatus: "active",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
});
let root: Root, element: HTMLDivElement, client: QueryClient;
let width = 1280;
let prefs: ReturnType<typeof useUiPreferences>,
  owner: ReturnType<typeof useCockpitScope>,
  draft: ReturnType<typeof useSessionDraft<{ text: string }>>;
let editor: { open: boolean; set: (value: { open: boolean; citadelId: string; workspaceId: string }) => void };
function Probe() {
  const [choice, setChoice] = useState({ open: true, citadelId: "cit-b", workspaceId: "ws-b" });
  editor = { open: choice.open, set: setChoice };
  prefs = useUiPreferences();
  owner = useCockpitScope(choice.open, choice, () => setChoice((value) => ({ ...value, open: false })));
  draft = useSessionDraft(`scope-draft:${prefs.activeWorkspaceId}`, { text: "Saved" }, 1, { label: "Scope draft" });
  return (
    <>
      <ScopeSwitcher />
      <MobileTabBar onOpenPalette={() => undefined} />
    </>
  );
}
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <UiPreferencesProvider>
          <CockpitNavigationProvider>
            <Probe />
          </CockpitNavigationProvider>
        </UiPreferencesProvider>
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(owner.ready).toBe(true));
}
async function reopen() {
  await act(async () => {
    editor.set({ open: true, citadelId: "cit-b", workspaceId: "ws-b" });
  });
  await vi.waitFor(() => expect(owner.ready).toBe(true));
}
async function click(text: string) {
  await vi.waitFor(() =>
    expect(
      [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === text && !node.disabled),
    ).toBeDefined(),
  );
  const button = [...document.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === text && !node.disabled,
  );
  expect(button).toBeDefined();
  await act(async () => {
    button!.click();
  });
}
beforeEach(() => {
  width = 1280;
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    matches: query.includes("min-width") || query.includes(">=") ? width >= 640 : width < 640,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  vi.clearAllMocks();
  resetChatSessionCreationForTests();
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
  mocks.installation = "http://scope.invalid";
  window.localStorage.setItem("goatcitadel.ui.citadel_id.v1", "cit-a");
  window.localStorage.setItem("goatcitadel.ui.workspace_id.v1", "ws-a");
  window.history.replaceState(null, "", "/work/runs/old?runId=old&shell=cockpit");
  mocks.citadels.mockResolvedValue({ items: [citadel("cit-a"), citadel("cit-b")] });
  mocks.currentCitadel.mockImplementation(async (id) => ({
    citadelId: id,
    revision: citadel(id).revision,
    record: { ...citadel(id), name: "Personal operations" },
    charter: null,
    chambers: [],
  }));
  mocks.workspaces.mockImplementation(async (_view, _limit, id) => ({
    items: [workspace(id === "cit-a" ? "ws-a" : "ws-b", id)],
    citadelId: id,
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  client.clear();
  resetChatSessionCreationForTests();
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("cockpit scope owner", () => {
  it("shows the current canonical Citadel name before opening its picker, including a Citadel without a Charter", async () => {
    await render();
    await vi.waitFor(() =>
      expect(document.querySelector('[aria-label="Change Citadel and workspace"]')?.textContent).toContain(
        "Personal operations",
      ),
    );
    expect(document.querySelector('[aria-label="Change operating scope"]')).toBeNull();
    expect(mocks.currentCitadel).toHaveBeenCalledTimes(1);
    expect(mocks.currentCitadel.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
  it("keeps the last known Citadel name while the Citadel is read again (NV-03)", async () => {
    await render();
    const trigger = () => document.querySelector('[aria-label="Change Citadel and workspace"]')?.textContent;
    await vi.waitFor(() => expect(trigger()).toContain("Personal operations"));
    let release!: () => void;
    mocks.currentCitadel.mockImplementationOnce(
      (id) =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              citadelId: id,
              revision: citadel(id).revision,
              record: { ...citadel(id), name: "Personal operations" },
              charter: null,
              chambers: [],
            });
        }),
    );
    await act(async () => {
      void client.invalidateQueries({ queryKey: ["system", "directory", "active-citadel"] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.currentCitadel).toHaveBeenCalledTimes(2);
    expect(trigger()).toContain("Personal operations");
    expect(trigger()).not.toContain("Reading Citadel");
    await act(async () => release());
  });
  it("keeps the scope choices listed while the directory is read again", async () => {
    await render();
    let release!: () => void;
    mocks.citadels.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ items: [citadel("cit-a"), citadel("cit-b")] });
        }),
    );
    await act(async () => {
      void client.invalidateQueries({ queryKey: ["system", "directory", "scope-citadels"] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(owner.checking).toBe(true);
    expect(owner.loading).toBe(false);
    expect(owner.ready).toBe(false);
    expect(owner.citadels.map((item) => item.citadelId)).toEqual(["cit-a", "cit-b"]);
    await act(async () => release());
    await vi.waitFor(() => expect(owner.ready).toBe(true));
  });
  it("withholds a foreign or unavailable current Citadel name", async () => {
    mocks.currentCitadel.mockResolvedValue({
      citadelId: "foreign",
      revision: citadel("foreign").revision,
      record: citadel("foreign"),
      charter: null,
      chambers: [],
    });
    await render();
    await vi.waitFor(() =>
      expect(document.querySelector('[aria-label="Change Citadel and workspace"]')?.textContent).toContain(
        "Citadel unavailable",
      ),
    );
    expect(document.querySelector('[aria-label="Change Citadel and workspace"]')?.textContent).not.toContain("foreign");
  });
  it("does not read the current Citadel for the hidden phone trigger", async () => {
    width = 390;
    await render();
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["system", "directory", "active-citadel"] });
    });
    expect(mocks.currentCitadel).not.toHaveBeenCalled();
  });
  it("requires one real leave decision, keeps the origin draft/unknown lock and atomically changes verified scope", async () => {
    await render();
    await act(async () => {
      prefs.setActiveScope({ citadelId: "cit-a", workspaceId: "ws-a" });
    });
    await act(async () => {
      draft.setValue({ text: "Keep exact text" });
    });
    const key = chatSessionCreationKey(mocks.installation, "ws-a");
    beginChatSessionCreation(key, { state: "unknown", mode: "chat", message: "Unknown original receipt" });
    const before = mocks.workspaces.mock.calls.length;
    await act(async () => {
      owner.select("cit-b", "ws-b");
    });
    expect(document.querySelectorAll('[role="dialog"][data-state="open"]')).toHaveLength(1);
    expect(prefs.activeWorkspaceId).toBe("ws-a");
    expect(mocks.workspaces.mock.calls.length).toBe(before);
    await click("Cancel");
    expect(draft.value.text).toBe("Keep exact text");
    await reopen();
    await act(async () => {
      owner.select("cit-b", "ws-b");
    });
    await click("Keep draft and close");
    expect([prefs.activeCitadelId, prefs.activeWorkspaceId]).toEqual(["cit-b", "ws-b"]);
    expect(window.location.pathname + window.location.search).toBe("/work?shell=cockpit");
    expect(readChatSessionCreation(key)?.state).toBe("unknown");
    await act(async () => {
      prefs.setActiveScope({ citadelId: "cit-a", workspaceId: "ws-a" });
    });
    expect(draft.value.text).toBe("Keep exact text");
    expect(readChatSessionCreation(key)?.state).toBe("unknown");
    expect(beginChatSessionCreation(key, { state: "pending", mode: "chat", message: "Forbidden replay" })).toBe(false);
    expect(readChatSessionCreation(key)?.message).toBe("Unknown original receipt");
    expect(mocks.workspaces.mock.calls.at(-1)?.[3]?.signal).toBeInstanceOf(AbortSignal);
  });
  it("withholds archived/reparented fresh membership without changing preferences or the entity URL", async () => {
    await render();
    const before = [prefs.activeCitadelId, prefs.activeWorkspaceId, window.location.href];
    mocks.workspaces.mockResolvedValueOnce({ items: [workspace("ws-b", "foreign")] });
    await act(async () => {
      owner.select("cit-b", "ws-b");
    });
    expect([prefs.activeCitadelId, prefs.activeWorkspaceId, window.location.href]).toEqual(before);
    expect(owner.error).not.toBe("");
  });
  it("does not apply an old asynchronous review after workspace ABA or installation change", async () => {
    await render();
    let finish!: (value: { items: WorkspaceRecord[] }) => void;
    mocks.workspaces.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const old = owner.select;
    await act(async () => {
      owner.select("cit-b", "ws-b");
    });
    await act(async () => {
      prefs.setActiveScope({ citadelId: "cit-b", workspaceId: "other" });
    });
    await act(async () => {
      prefs.setActiveScope({ citadelId: "cit-a", workspaceId: "ws-a" });
    });
    await act(async () => {
      finish({ items: [workspace("ws-b")] });
    });
    expect(prefs.activeWorkspaceId).toBe("ws-a");
    const count = mocks.workspaces.mock.calls.length;
    await act(async () => {
      old("cit-b", "ws-b");
    });
    expect(mocks.workspaces).toHaveBeenCalledTimes(count);
    await reopen();
    const freshCount = mocks.workspaces.mock.calls.length;
    mocks.installation = "http://other.invalid";
    await act(async () => {
      owner.select("cit-b", "ws-b");
    });
    expect(mocks.workspaces).toHaveBeenCalledTimes(freshCount);
  });
  it("does not reopen the scope dialog over an outstanding leave review", async () => {
    await render();
    await act(async () => {
      draft.setValue({ text: "Dirty" });
    });
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Change Citadel and workspace"]')!;
    await act(async () => {
      owner.select("cit-b", "ws-b");
      trigger.click();
    });
    expect(document.querySelectorAll('[role="dialog"][data-state="open"]')).toHaveLength(1);
    expect(document.body.textContent).toContain("Unsaved changes");
  });
  it("admits one owned preflight, blocks duplicate triggers, and releases a cancelled review", async () => {
    await render();
    await act(async () => {
      draft.setValue({ text: "Dirty" });
    });
    const count = mocks.workspaces.mock.calls.length;
    await act(async () => {
      owner.select("cit-b", "ws-b");
      owner.select("cit-b", "ws-b");
    });
    expect(document.querySelectorAll('[role="dialog"][data-state="open"]')).toHaveLength(1);
    expect(owner.isTransitionPending()).toBe(true);
    expect(mocks.workspaces).toHaveBeenCalledTimes(count);
    await click("Cancel");
    expect(owner.isTransitionPending()).toBe(false);
    await reopen();
    await act(async () => {
      owner.select("cit-b", "ws-b");
    });
    let settle!: (value: { items: WorkspaceRecord[] }) => void;
    mocks.workspaces.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    await click("Keep draft and close");
    expect(owner.isTransitionPending()).toBe(true);
    const inFlight = mocks.workspaces.mock.calls.length;
    await act(async () => {
      owner.select("cit-b", "ws-b");
    });
    expect(mocks.workspaces).toHaveBeenCalledTimes(inFlight);
    await act(async () => {
      settle({ items: [workspace("ws-b")] });
    });
    expect([prefs.activeCitadelId, prefs.activeWorkspaceId]).toEqual(["cit-b", "ws-b"]);
    expect(owner.isTransitionPending()).toBe(false);
  });
  it("discards only the reviewed origin draft before one verified scope change", async () => {
    await render();
    await act(async () => {
      draft.setValue({ text: "Discard this edit" });
    });
    const before = mocks.workspaces.mock.calls.length;
    await act(async () => {
      owner.select("cit-b", "ws-b");
    });
    await click("Discard changes");
    expect([prefs.activeCitadelId, prefs.activeWorkspaceId]).toEqual(["cit-b", "ws-b"]);
    expect(mocks.workspaces).toHaveBeenCalledTimes(before + 1);
    await act(async () => {
      prefs.setActiveScope({ citadelId: "cit-a", workspaceId: "ws-a" });
    });
    expect(draft.value.text).toBe("Saved");
  });

  it("closes the phone More sheet before scope review and prevents a retained More trigger reopening over consent", async () => {
    await render();
    await act(async () => {
      draft.setValue({ text: "Phone draft" });
    });
    const more = document.querySelector<HTMLButtonElement>('[aria-label="More areas and settings"]')!;
    await act(async () => {
      more.click();
    });
    await click("Change Citadel and workspace");
    expect(document.querySelectorAll('[role="dialog"][data-state="open"]')).toHaveLength(1);
    expect(document.body.textContent).toContain("Change operating scope");
    await vi.waitFor(() =>
      expect(
        document.querySelector(
          '[role="dialog"][data-state="open"] [aria-label="Scope Citadel"] option[value="cit-b"]:not(:disabled)',
        ),
      ).not.toBeNull(),
    );
    const citadelSelect = document.querySelector<HTMLSelectElement>(
      '[role="dialog"][data-state="open"] [aria-label="Scope Citadel"]',
    )!;
    await act(async () => {
      citadelSelect.value = "cit-b";
      citadelSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await vi.waitFor(() =>
      expect(
        document.querySelector(
          '[role="dialog"][data-state="open"] [aria-label="Scope Workspace"] option[value="ws-b"]:not(:disabled)',
        ),
      ).not.toBeNull(),
    );
    const workspaceSelect = document.querySelector<HTMLSelectElement>(
      '[role="dialog"][data-state="open"] [aria-label="Scope Workspace"]',
    )!;
    await act(async () => {
      workspaceSelect.value = "ws-b";
      workspaceSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("Switch scope");
    await act(async () => {
      more.click();
    });
    expect(document.querySelectorAll('[role="dialog"][data-state="open"]')).toHaveLength(1);
    expect(document.body.textContent).toContain("Unsaved changes");
    await click("Cancel");
    expect(prefs.activeWorkspaceId).toBe("ws-a");
    expect(draft.value.text).toBe("Phone draft");
    await vi.waitFor(() => expect(document.activeElement).toBe(more));
    await vi.waitFor(() => expect(owner.isTransitionPending()).toBe(false));
    await act(async () => {
      more.click();
    });
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Change Citadel and workspace"),
    );
  });

  it("rejects a retained picker callback after an external close before admission", async () => {
    await render();
    const old = owner.select,
      before = mocks.workspaces.mock.calls.length;
    await act(async () => {
      editor.set({ open: false, citadelId: "cit-b", workspaceId: "ws-b" });
    });
    await act(async () => {
      old("cit-b", "ws-b");
    });
    expect(mocks.workspaces).toHaveBeenCalledTimes(before);
    expect(prefs.activeWorkspaceId).toBe("ws-a");
  });
  it.each(["choice ABA", "route ABA", "unmount"])(
    "aborts an owned preflight on %s and withholds its late success",
    async (kind) => {
      await render();
      const sourceUrl = window.location.href;
      let finish!: (value: { items: WorkspaceRecord[] }) => void;
      mocks.workspaces.mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      await act(async () => {
        owner.select("cit-b", "ws-b");
      });
      expect(editor.open).toBe(false); // The one owned close must not invalidate its own accepted preflight.
      const signal = mocks.workspaces.mock.calls.at(-1)?.[3]?.signal;
      expect(signal?.aborted).toBe(false);
      if (kind === "choice ABA") {
        await act(async () => {
          editor.set({ open: false, citadelId: "cit-a", workspaceId: "ws-a" });
        });
        await act(async () => {
          editor.set({ open: false, citadelId: "cit-b", workspaceId: "ws-b" });
        });
      } else if (kind === "route ABA") {
        await act(async () => {
          window.history.pushState(null, "", "/inbox?shell=cockpit");
          window.dispatchEvent(new Event("goatcitadel:cockpit-location"));
        });
        await act(async () => {
          window.history.pushState(null, "", sourceUrl);
          window.dispatchEvent(new Event("goatcitadel:cockpit-location"));
        });
      } else
        await act(async () => {
          root.render(<div>Replacement view</div>);
        });
      expect(signal?.aborted).toBe(true);
      await act(async () => {
        finish({ items: [workspace("ws-b")] });
      });
      expect(window.localStorage.getItem("goatcitadel.ui.workspace_id.v1")).toBe("ws-a");
      expect(window.location.href).toBe(sourceUrl);
    },
  );

  it("restores the live scope opener on keyboard dismissal without stealing focus from leave consent", async () => {
    await render();
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Change Citadel and workspace"]')!;
    await act(async () => {
      trigger.focus();
      trigger.click();
    });
    const close = document.querySelector<HTMLButtonElement>('[role="dialog"] [aria-label="Close dialog"]')!;
    await act(async () => {
      close.click();
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    await act(async () => {
      draft.setValue({ text: "Retained" });
      trigger.click();
    });
    await vi.waitFor(() =>
      expect(
        document.querySelector(
          '[role="dialog"][data-state="open"] [aria-label="Scope Citadel"] option[value="cit-b"]:not(:disabled)',
        ),
      ).not.toBeNull(),
    );
    const citadelSelect = document.querySelector<HTMLSelectElement>(
      '[role="dialog"][data-state="open"] [aria-label="Scope Citadel"]',
    )!;
    await act(async () => {
      citadelSelect.value = "cit-b";
      citadelSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await vi.waitFor(() =>
      expect(
        document.querySelector(
          '[role="dialog"][data-state="open"] [aria-label="Scope Workspace"] option[value="ws-b"]:not(:disabled)',
        ),
      ).not.toBeNull(),
    );
    const workspaceSelect = document.querySelector<HTMLSelectElement>(
      '[role="dialog"][data-state="open"] [aria-label="Scope Workspace"]',
    )!;
    await act(async () => {
      workspaceSelect.value = "ws-b";
      workspaceSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("Switch scope");
    const consent = document.querySelector('[role="dialog"]')!;
    expect(consent.textContent).toContain("Unsaved changes");
    expect(consent.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(trigger);
    await click("Cancel");
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(draft.value.text).toBe("Retained");
  });

  it.each(["failed preflight", "accepted scope", "route ABA"])(
    "restores only current-origin focus after consent: %s",
    async (outcome) => {
      await render();
      await act(async () => {
        draft.setValue({ text: "Retained" });
      });
      const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Change Citadel and workspace"]')!;
      await act(async () => {
        trigger.focus();
        trigger.click();
      });
      await vi.waitFor(() =>
        expect(
          document.querySelector(
            '[role="dialog"][data-state="open"] [aria-label="Scope Citadel"] option[value="cit-b"]:not(:disabled)',
          ),
        ).not.toBeNull(),
      );
      const citadelSelect = document.querySelector<HTMLSelectElement>(
        '[role="dialog"][data-state="open"] [aria-label="Scope Citadel"]',
      )!;
      await act(async () => {
        citadelSelect.value = "cit-b";
        citadelSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await vi.waitFor(() =>
        expect(
          document.querySelector(
            '[role="dialog"][data-state="open"] [aria-label="Scope Workspace"] option[value="ws-b"]:not(:disabled)',
          ),
        ).not.toBeNull(),
      );
      const workspaceSelect = document.querySelector<HTMLSelectElement>(
        '[role="dialog"][data-state="open"] [aria-label="Scope Workspace"]',
      )!;
      await act(async () => {
        workspaceSelect.value = "ws-b";
        workspaceSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await click("Switch scope");
      let settle!: (value: { items: WorkspaceRecord[] }) => void;
      mocks.workspaces.mockReturnValueOnce(
        new Promise((resolve) => {
          settle = resolve;
        }),
      );
      const focus = vi.spyOn(trigger, "focus");
      await click("Keep draft and close");
      expect(owner.isTransitionPending()).toBe(true);
      expect(focus).not.toHaveBeenCalled();
      if (outcome === "route ABA") {
        const source = window.location.href;
        await act(async () => {
          window.history.pushState(null, "", "/inbox?shell=cockpit");
          window.dispatchEvent(new Event("goatcitadel:cockpit-location"));
        });
        await act(async () => {
          window.history.pushState(null, "", source);
          window.dispatchEvent(new Event("goatcitadel:cockpit-location"));
        });
      }
      await act(async () => {
        settle({ items: outcome === "failed preflight" ? [workspace("ws-b", "foreign")] : [workspace("ws-b")] });
      });
      if (outcome === "failed preflight") {
        await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
        expect(prefs.activeWorkspaceId).toBe("ws-a");
        expect(document.body.textContent).toContain("could not be verified");
      } else {
        await act(async () => {
          await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        });
        expect(focus).not.toHaveBeenCalled();
        expect(prefs.activeWorkspaceId).toBe(outcome === "accepted scope" ? "ws-b" : "ws-a");
      }
    },
  );
});
