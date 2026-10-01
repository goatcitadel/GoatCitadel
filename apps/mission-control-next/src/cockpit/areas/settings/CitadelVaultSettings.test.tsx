import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CitadelVaultSnapshot } from "@goatcitadel/contracts";
import { CitadelVaultSettings } from "./CitadelVaultSettings";
import { __resetCitadelVaultAttemptsForTests } from "../../../features/native-routes/library/citadel-vault-state";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
const api = vi.hoisted(() => ({ read: vi.fn(), store: vi.fn(), remove: vi.fn(), reveal: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  getCitadelVaultSnapshot: api.read,
  storeCitadelVaultSecret: api.store,
  deleteCitadelVaultSecret: api.remove,
  revealCitadelVaultSecret: api.reveal,
  isApiRequestError: () => false,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => "http://fixture",
}));
vi.mock("../../ui/Sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <aside>{children}</aside> : null),
}));
vi.mock("../../ui/Dialog", () => ({
  Dialog: ({ open, children, title }: { open: boolean; children: ReactNode; title: string }) =>
    open ? <section aria-label={title}>{children}</section> : null,
}));
vi.mock("../../ui/ClassicOwnerLink", () => ({
  ClassicOwnerLink: ({ label }: { label: string }) => <button type="button">{label}</button>,
}));
let renderer: ReactTestRenderer | undefined, owner: CitadelVaultSnapshot;
function text(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(text).join(" ");
}
function button(label: string) {
  return renderer!.root.findAllByType("button").find((node) => text(node).replace(/\s+/gu, " ").trim() === label)!;
}
async function mount() {
  await act(async () => {
    renderer = create(<CitadelVaultSettings citadelId="citadel" />);
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  __resetCitadelVaultAttemptsForTests();
  __resetSessionDraftsForTests();
  owner = { citadelId: "citadel", revision: "a".repeat(64), items: [] };
  api.read.mockImplementation(async () => owner);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
});
it("renders bounded public names and explicit native reveal inspection without fetching values", async () => {
  owner.items = Array.from({ length: 51 }, (_, index) => ({
    secretId: `secret-${index}`,
    secretName: `Name ${index}`,
    createdAt: "2026-09-30T00:00:00Z",
    updatedAt: "2026-09-30T00:00:00Z",
  }));
  await mount();
  expect(renderer!.root.findAllByType("li")).toHaveLength(50);
  expect(api.reveal).not.toHaveBeenCalled();
  await act(async () => button("Inspect Name 0").props.onClick());
  expect(button("Reveal secret")).toBeDefined();
  expect(api.reveal).not.toHaveBeenCalled();
  expect(text(renderer!.root)).toContain("hides after 30 seconds");
  expect(JSON.stringify(renderer!.toJSON())).not.toContain("mc-next-");
});
it("keeps an uncertain store locked across native remount without leaking upstream error text", async () => {
  await mount();
  await act(async () => button("Store secret").props.onClick());
  const inputs = renderer!.root.findAllByType("input");
  await act(async () =>
    inputs.find((node) => node.props.id.endsWith("-name"))!.props.onChange({ target: { value: "Example" } }),
  );
  await act(async () =>
    inputs.find((node) => node.props.type === "password")!.props.onChange({ target: { value: "synthetic-secret" } }),
  );
  api.store.mockRejectedValueOnce(new Error("upstream echoed synthetic-secret"));
  await act(async () => button("Seal & store").props.onClick());
  expect(button("Seal & store").props.disabled).toBe(true);
  expect(text(renderer!.root)).toContain("outcome is unconfirmed");
  expect(text(renderer!.root)).not.toContain("upstream echoed");
  await act(async () => renderer!.unmount());
  await mount();
  expect(button("Store secret · Unsaved").props.disabled).toBe(true);
  expect(api.store).toHaveBeenCalledTimes(1);
});
it("renders native leave actions that cancel or discard without writing a secret", async () => {
  await mount();
  await act(async () => button("Store secret").props.onClick());
  await act(async () =>
    renderer!.root
      .findAllByType("input")
      .find((node) => node.props.type === "password")!
      .props.onChange({ target: { value: "synthetic-draft" } }),
  );
  await act(async () => button("Close secret editor").props.onClick());
  expect(renderer!.root.findByProps({ "aria-label": "Unsaved changes" })).toBeDefined();
  await act(async () => button("Cancel").props.onClick());
  expect(renderer!.root.findAllByType("input").find((node) => node.props.type === "password")!.props.value).toBe(
    "synthetic-draft",
  );
  await act(async () => button("Close secret editor").props.onClick());
  await act(async () => button("Discard changes").props.onClick());
  await act(async () => button("Store secret").props.onClick());
  expect(renderer!.root.findAllByType("input").find((node) => node.props.type === "password")!.props.value).toBe("");
  expect(api.store).not.toHaveBeenCalled();
  expect(api.remove).not.toHaveBeenCalled();
});
