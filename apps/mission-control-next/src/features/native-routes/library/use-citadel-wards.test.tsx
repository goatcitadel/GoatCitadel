// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CitadelAccessSnapshot } from "@goatcitadel/contracts";
import { useCitadelWards } from "./use-citadel-wards";
import { __resetSessionDraftsForTests } from "./session-drafts";
import { __resetCitadelAccessAttemptsForTests } from "./citadel-access-state";
import { overviewStructure } from "./citadel-overview.test-support";
const api = vi.hoisted(() => ({
  getCitadelAccessSnapshot: vi.fn(),
  addCitadelWard: vi.fn(),
  removeCitadelWard: vi.fn(),
  evaluateCitadelGatehouseAction: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => "http://one" }));
let root: Root,
  container: HTMLDivElement,
  scope: string,
  control: ReturnType<typeof useCitadelWards>,
  owner: CitadelAccessSnapshot;
const fixture = (id = "one"): CitadelAccessSnapshot => ({
  citadelId: id,
  revision: "a".repeat(64),
  structure: { ...overviewStructure(), citadelId: id },
  council: [],
  wards: [],
  passages: [],
  members: [],
  integrations: [],
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function Harness() {
  control = useCitadelWards(scope);
  return <p>{control.probeError}</p>;
}
async function render(next = scope) {
  scope = next;
  await act(async () => root.render(<Harness />));
}
async function review() {
  await act(async () => {
    control.setView("new");
    control.setDraft({ name: "Deny", actionPattern: "shell.*", effect: "deny" });
  });
  await act(async () => expect(control.requestAddWard()).toBe(true));
}
beforeEach(async () => {
  vi.resetAllMocks();
  __resetSessionDraftsForTests();
  __resetCitadelAccessAttemptsForTests();
  scope = "one";
  owner = fixture();
  api.getCitadelAccessSnapshot.mockImplementation(async () => structuredClone(owner));
  api.addCitadelWard.mockImplementation(async () => {
    owner = {
      ...owner,
      revision: "b".repeat(64),
      wards: [
        { wardId: "ward", citadelId: scope, name: "Deny", actionPattern: "shell.*", effect: "deny", createdAt: "now" },
      ],
    };
    return structuredClone(owner);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
describe("shared Ward editor lifetime", () => {
  it.each(["draft", "view", "cancel", "scope-round-trip"])(
    "withholds dispatch when %s changes during preflight",
    async (kind) => {
      await review();
      const before = owner,
        pending = deferred<CitadelAccessSnapshot>();
      api.getCitadelAccessSnapshot.mockReturnValueOnce(pending.promise);
      let saving!: Promise<boolean>;
      await act(async () => {
        saving = control.addWard();
      });
      if (kind === "draft") await act(async () => control.setDraft((draft) => ({ ...draft, name: "New input" })));
      if (kind === "view") await act(async () => control.setView("test"));
      if (kind === "cancel") await act(async () => control.cancelAddReview());
      if (kind === "scope-round-trip") {
        owner = fixture("two");
        await render("two");
        owner = fixture();
        await render("one");
      }
      await act(async () => {
        pending.resolve(before);
        expect(await saving).toBe(false);
      });
      expect(api.addCitadelWard).not.toHaveBeenCalled();
      expect(control.access.attempt.phase).toBe("idle");
    },
  );
  it("acknowledges the submitted rule while preserving text entered after dispatch", async () => {
    await review();
    const reply = deferred<CitadelAccessSnapshot>();
    api.addCitadelWard.mockReturnValueOnce(reply.promise);
    let saving!: Promise<boolean>;
    await act(async () => {
      saving = control.addWard();
    });
    expect(api.addCitadelWard).toHaveBeenCalledTimes(1);
    await act(async () => control.setDraft((draft) => ({ ...draft, name: "Keep new input" })));
    owner = {
      ...owner,
      revision: "b".repeat(64),
      wards: [
        { wardId: "ward", citadelId: scope, name: "Deny", actionPattern: "shell.*", effect: "deny", createdAt: "now" },
      ],
    };
    await act(async () => {
      reply.resolve(owner);
      expect(await saving).toBe(false);
    });
    expect(control.draft.name).toBe("Keep new input");
    expect(control.wardDraft.baseRevision).toBe(owner.revision);
    expect(control.wardDraft.isDirty).toBe(true);
    expect(control.wards.items).toEqual(owner.wards);
  });
  it("invalidates a typed probe result and releases its admission after it settles", async () => {
    const reply = deferred<{ action: string; effect: string }>();
    api.evaluateCitadelGatehouseAction.mockReturnValueOnce(reply.promise);
    await act(async () => {
      control.setView("test");
      control.setProbe("shell.run");
    });
    let probing!: Promise<void>;
    await act(async () => {
      probing = control.evaluate();
    });
    await act(async () => {
      control.setProbe("file.read");
      void control.evaluate();
    });
    expect(api.evaluateCitadelGatehouseAction).toHaveBeenCalledTimes(1);
    await act(async () => {
      reply.resolve({ action: "shell.run", effect: "deny" });
      await probing;
    });
    expect(control.probeResult).toBeNull();
    expect(control.probeBusy).toBe(false);
    api.evaluateCitadelGatehouseAction.mockResolvedValue({ action: "file.read", effect: "allow" });
    await act(async () => control.evaluate());
    expect(control.probeResult?.action).toBe("file.read");
  });
  it("settles the origin draft after a confirmed late save without replacing a newer view", async () => {
    await review();
    const before = owner,
      reply = deferred<CitadelAccessSnapshot>();
    api.addCitadelWard.mockReturnValueOnce(reply.promise);
    let saving!: Promise<boolean>;
    await act(async () => {
      saving = control.addWard();
    });
    const saved: CitadelAccessSnapshot = {
      ...before,
      revision: "b".repeat(64),
      wards: [
        { wardId: "ward", citadelId: "one", name: "Deny", actionPattern: "shell.*", effect: "deny", createdAt: "now" },
      ],
    };
    owner = fixture("two");
    api.getCitadelAccessSnapshot.mockImplementation(async (id: string) =>
      structuredClone(id === "one" ? saved : owner),
    );
    await render("two");
    await act(async () => {
      reply.resolve(saved);
      expect(await saving).toBe(false);
    });
    expect(control.access.ready).toBe(true);
    expect(control.view).toBeNull();
    owner = saved;
    await render("one");
    expect(control.wardDraft.isDirty).toBe(false);
    expect(control.draft.name).toBe("");
  });
  it("keeps the operator's newer selection when a dispatched add finishes", async () => {
    await review();
    const reply = deferred<CitadelAccessSnapshot>();
    api.addCitadelWard.mockReturnValueOnce(reply.promise);
    let saving!: Promise<boolean>;
    await act(async () => {
      saving = control.addWard();
    });
    await act(async () => {
      control.setView("test");
      control.setSelectedWardId("new-selection");
    });
    owner = {
      ...owner,
      revision: "b".repeat(64),
      wards: [
        { wardId: "ward", citadelId: "one", name: "Deny", actionPattern: "shell.*", effect: "deny", createdAt: "now" },
      ],
    };
    await act(async () => {
      reply.resolve(owner);
      await saving;
    });
    expect(control.view).toBe("test");
    expect(control.selectedWard).toBeNull();
    expect(control.wardDraft.isDirty).toBe(false);
  });
  it("discards an old probe even after returning to its original Citadel", async () => {
    const reply = deferred<{ action: string; effect: string }>();
    api.evaluateCitadelGatehouseAction.mockReturnValueOnce(reply.promise);
    await act(async () => {
      control.setView("test");
      control.setProbe("shell.run");
    });
    let probing!: Promise<void>;
    await act(async () => {
      probing = control.evaluate();
    });
    owner = fixture("two");
    await render("two");
    owner = fixture();
    await render("one");
    await act(async () => {
      reply.resolve({ action: "shell.run", effect: "deny" });
      await probing;
    });
    expect(control.probeResult).toBeNull();
    expect(control.probeBusy).toBe(false);
  });
});
