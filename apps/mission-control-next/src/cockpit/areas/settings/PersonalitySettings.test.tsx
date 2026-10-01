// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersonalityCatalogResponse } from "@goatcitadel/contracts";
import type { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { __resetPersonalityDefaultForTests } from "../../../features/native-routes/settings/use-personality-default";
import { PersonalitySettings } from "./PersonalitySettings";

const api = vi.hoisted(() => ({ fetchPersonalities: vi.fn(), setDefaultPersonality: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  ...api,
  isApiRequestError: (value: unknown) => Boolean(value && typeof value === "object" && "status" in value),
}));
let confirmation: ComponentProps<typeof ConfirmModal>;
vi.mock("@goatcitadel/mission-control-shared/components/ConfirmModal", () => ({
  ConfirmModal: (props: ComponentProps<typeof ConfirmModal>) => {
    confirmation = props;
    return null;
  },
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
let client: QueryClient;
const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PersonalitySettings />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(container.textContent).not.toContain("Loading personality catalog"));
}
async function choose(id: string) {
  await act(async () => {
    const select = container.querySelector("select")!;
    select.value = id;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  __resetPersonalityDefaultForTests();
  owner = { revision: "a".repeat(64), defaultPersonalityId: "default", items: [preset("default"), preset("operator")] };
  api.fetchPersonalities.mockImplementation(async () => owner);
  api.setDefaultPersonality.mockImplementation(async (id: string) => {
    owner = { ...owner, revision: "b".repeat(64), defaultPersonalityId: id };
    return owner;
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  __resetPersonalityDefaultForTests();
});

describe("native Work personality", () => {
  it("shows exact saved owner instructions, confirms global scope, and waits for review before mutation", async () => {
    await render();
    expect(container.textContent).toContain("Current global default: default");
    await choose("operator");
    expect(container.textContent).toContain("Saved operator instructions");
    await act(async () => button("Review global default").click());
    expect(confirmation.open).toBe(true);
    expect(confirmation.message).toContain("global Work default");
    expect(confirmation.message).toContain("future Work turns, including existing conversations");
    expect(container.textContent).toContain("future Work turns, including existing conversations");
    expect(container.querySelector("details code")?.textContent).toBe("a".repeat(64));
    expect(api.setDefaultPersonality).not.toHaveBeenCalled();
    await act(async () => confirmation.onConfirm());
    await vi.waitFor(() => expect(container.textContent).toContain("Current global default: operator"));
    expect(api.setDefaultPersonality).toHaveBeenCalledExactlyOnceWith("operator", "a".repeat(64));
  });
  it("cancels without mutation and clears the global overlay only after explicit review", async () => {
    owner = { ...owner, defaultPersonalityId: "operator" };
    await render();
    await choose("default");
    await act(async () => button("Review global default").click());
    expect(confirmation.message).toContain("Clear the global Work personality");
    await act(async () => confirmation.onCancel());
    expect(api.setDefaultPersonality).not.toHaveBeenCalled();
    expect(confirmation.open).toBe(false);
    await act(async () => button("Review global default").click());
    await act(async () => confirmation.onConfirm());
    await vi.waitFor(() => expect(container.textContent).toContain("Current global default: default"));
  });
  it("hides cached editable data when refresh fails and preserves the selection after recovery", async () => {
    await render();
    await choose("operator");
    api.fetchPersonalities.mockRejectedValue(new Error("offline"));
    await act(async () => button("Refresh personality catalog").click());
    await vi.waitFor(() => expect(container.textContent).toContain("Personality catalog unavailable"));
    expect(container.querySelector("select")).toBeNull();
    api.fetchPersonalities.mockImplementation(async () => owner);
    await act(async () => button("Refresh personality catalog").click());
    await vi.waitFor(() => expect(container.querySelector("select")?.value).toBe("operator"));
    expect(api.setDefaultPersonality).not.toHaveBeenCalled();
  });
  it("keeps a missing selection visible and does not silently substitute a saved personality", async () => {
    await render();
    await choose("operator");
    owner = { ...owner, revision: "c".repeat(64), items: [preset("default")] };
    await act(async () => button("Refresh personality catalog").click());
    await vi.waitFor(() => expect(container.textContent).toContain("selected personality is missing"));
    expect(container.querySelector("select")?.value).toBe("operator");
    expect(button("Review global default").disabled).toBe(true);
  });
  it("rejects a catalog without the owner revision or its declared default", async () => {
    owner = { ...owner, revision: "", defaultPersonalityId: "absent" };
    await render();
    expect(container.textContent).toContain("did not provide a reviewable personality catalog");
    expect(container.querySelector("select")).toBeNull();
  });
});
