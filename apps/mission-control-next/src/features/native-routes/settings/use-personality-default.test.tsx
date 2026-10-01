// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersonalityCatalogResponse } from "@goatcitadel/contracts";
import { __resetPersonalityDefaultForTests, usePersonalityDefault } from "./use-personality-default";

const api = vi.hoisted(() => ({ fetchPersonalities: vi.fn(), setDefaultPersonality: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  ...api,
  isApiRequestError: (value: unknown) => Boolean(value && typeof value === "object" && "status" in value),
}));
const preset = (id: string) => ({
  id,
  label: id,
  category: "core" as const,
  description: `${id} description`,
  tone: "Direct",
  style: "Concise",
  systemOverlay: `Saved ${id} instructions`,
  soulFile: "",
  safetyNotes: ["Policy wins"],
  visibility: "builtin" as const,
  builtin: true,
});
let owner: PersonalityCatalogResponse;
let root: Root;
let container: HTMLDivElement;
let hook: ReturnType<typeof usePersonalityDefault>;
let available: boolean;
const reload = vi.fn(async () => undefined);
function Probe() {
  hook = usePersonalityDefault({ catalog: owner, available, reload });
  return null;
}
async function render() {
  await act(async () => root.render(<Probe />));
}
async function review() {
  await act(async () => hook.requestReview("operator"));
}
async function confirm() {
  await act(async () => {
    await hook.confirm();
  });
}
beforeEach(async () => {
  vi.resetAllMocks();
  __resetPersonalityDefaultForTests();
  owner = { revision: "a".repeat(64), defaultPersonalityId: "default", items: [preset("default"), preset("operator")] };
  api.fetchPersonalities.mockImplementation(async () => owner);
  api.setDefaultPersonality.mockImplementation(async (id: string) => ({
    ...owner,
    revision: "b".repeat(64),
    defaultPersonalityId: id,
  }));
  available = true;
  container = document.createElement("div");
  root = createRoot(container);
  await render();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __resetPersonalityDefaultForTests();
});

describe("shared personality default owner action", () => {
  it("reviews saved instructions without a mutation and applies the exact catalog revision", async () => {
    await review();
    expect(api.setDefaultPersonality).not.toHaveBeenCalled();
    expect(hook.review?.preset.systemOverlay).toBe("Saved operator instructions");
    await confirm();
    expect(api.setDefaultPersonality).toHaveBeenCalledExactlyOnceWith("operator", "a".repeat(64));
    expect(hook.notice).toContain("confirmed by the Gateway");
    expect(hook.uncertain).toBe(false);
  });
  it("cancels review and refuses missing or unavailable selections", async () => {
    await review();
    act(() => hook.cancel());
    await confirm();
    act(() => hook.requestReview("absent"));
    expect(hook.review).toBeNull();
    available = false;
    await render();
    await review();
    expect(hook.review).toBeNull();
    expect(api.setDefaultPersonality).not.toHaveBeenCalled();
  });
  it("rechecks revision before mutation even if the displayed owner snapshot has not changed", async () => {
    await review();
    api.fetchPersonalities.mockResolvedValue({ ...owner, revision: "c".repeat(64) });
    await confirm();
    expect(api.setDefaultPersonality).not.toHaveBeenCalled();
    expect(hook.notice).toContain("catalog changed");
    expect(hook.locked).toBe(false);
  });
  it("withholds a previously opened confirmation when the owner becomes unavailable", async () => {
    await review();
    available = false;
    await render();
    await confirm();
    expect(api.setDefaultPersonality).not.toHaveBeenCalled();
    expect(hook.reviewCurrent).toBe(false);
  });
  it("allows fresh review after the exact owner precommit conflict", async () => {
    api.setDefaultPersonality.mockRejectedValue({
      status: 409,
      body: { code: "WRITE_CONFLICT", details: { reason: "PERSONALITY_CATALOG_REVISION_CONFLICT" } },
    });
    await review();
    await confirm();
    expect(hook.locked).toBe(false);
    expect(hook.notice).toContain("rejected a stale catalog revision");
    await review();
    expect(hook.review).not.toBeNull();
  });
  it.each([
    new Error("response lost"),
    { status: 409, body: { error: "Unspecified conflict" } },
    {
      status: 409,
      body: { code: "WRITE_CONFLICT", details: { reason: "PERSONALITY_CATALOG_REVISION_CONFLICT", committed: true } },
    },
  ])("locks unconfirmed mutation outcomes across navigation: %o", async (failure) => {
    api.setDefaultPersonality.mockRejectedValue(failure);
    await review();
    await confirm();
    expect(hook.uncertain).toBe(true);
    act(() => root.unmount());
    root = createRoot(container);
    await render();
    await review();
    await confirm();
    expect(hook.locked).toBe(true);
    expect(api.setDefaultPersonality).toHaveBeenCalledTimes(1);
  });
  it.each(["wrong-default", "same-revision", "missing-entry"])(
    "does not acknowledge a malformed committed response: %s",
    async (failure) => {
      api.setDefaultPersonality.mockResolvedValue({
        ...owner,
        revision: failure === "same-revision" ? owner.revision : "b".repeat(64),
        defaultPersonalityId: failure === "wrong-default" ? "default" : "operator",
        items: failure === "missing-entry" ? [preset("default")] : owner.items,
      });
      await review();
      await confirm();
      expect(hook.uncertain).toBe(true);
    },
  );
  it("retains the pending global attempt across navigation and prevents a duplicate mutation", async () => {
    let settle!: (catalog: PersonalityCatalogResponse) => void;
    api.setDefaultPersonality.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    await review();
    let saving!: Promise<boolean>;
    await act(async () => {
      saving = hook.confirm();
    });
    expect(hook.pending).toBe(true);
    act(() => root.unmount());
    root = createRoot(container);
    await render();
    await review();
    await confirm();
    expect(api.setDefaultPersonality).toHaveBeenCalledTimes(1);
    await act(async () => {
      settle({ ...owner, revision: "b".repeat(64), defaultPersonalityId: "operator" });
      await saving;
    });
    expect(hook.pending).toBe(false);
    expect(hook.notice).toContain("confirmed by the Gateway");
  });
  it("keeps commit truth when follow-up refresh fails", async () => {
    reload.mockRejectedValue(new Error("refresh failed"));
    await review();
    await confirm();
    expect(hook.notice).toContain("confirmed by the Gateway");
    expect(hook.uncertain).toBe(false);
  });
  it("does not lock retry when the preflight read fails before any mutation", async () => {
    api.fetchPersonalities.mockRejectedValue(new Error("offline"));
    await review();
    await confirm();
    expect(api.setDefaultPersonality).not.toHaveBeenCalled();
    expect(hook.locked).toBe(false);
    expect(hook.notice).toContain("Could not confirm");
  });
});
