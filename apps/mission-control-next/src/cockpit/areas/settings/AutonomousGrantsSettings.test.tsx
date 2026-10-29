import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { AutonomousGrantsSettings } from "./AutonomousGrantsSettings";
import { CockpitNavigationContext } from "../../app/cockpit-navigation-context";
import {
  autonomousGrantFixture as grant,
  revokedAutonomousGrantFixture as revoked,
} from "../../../features/native-routes/settings/autonomous-grant.test-support";
import { __resetAutonomousGrantRevocationsForTests } from "../../../features/native-routes/settings/use-autonomous-grant-revocation";
const api = vi.hoisted(() => ({
  getGatewayApiBaseUrl: vi.fn(),
  fetchAutonomousActivationGrants: vi.fn(),
  revokeAutonomousActivationGrant: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
const preferences = vi.hoisted(() => ({ showTechnicalDetails: false }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const useUiPreferences = actual.useUiPreferences as () => Record<string, unknown>;
  return { ...actual, useUiPreferences: () => ({ ...useUiPreferences(), ...preferences }) };
});
vi.mock("@goatcitadel/mission-control-shared/api/workspaces", () => ({
  fetchWorkspaces: async () => ({ items: [{ workspaceId: "workspace-a", name: "Research" }] }),
}));
vi.mock("../../ui/Dialog", () => ({
  Dialog: ({ open, children, description }: { open: boolean; children?: ReactNode; description?: string }) =>
    open ? (
      <section role="dialog">
        <p>{description}</p>
        {children}
      </section>
    ) : null,
}));
let view: ReactTestRenderer | undefined,
  client: QueryClient,
  rows = [grant];
const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
const button = (label: string) => view!.root.findAllByType("button").find((node) => text(node) === label)!;
async function click(label: string) {
  await act(async () => {
    button(label).props.onClick();
    await new Promise((done) => setTimeout(done, 10));
  });
}
async function render() {
  await act(async () => {
    view = create(
      <QueryClientProvider client={client}>
        <AutonomousGrantsSettings workspaceId="workspace-a" />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((done) => setTimeout(done, 10));
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  __resetAutonomousGrantRevocationsForTests();
  rows = [grant];
  api.getGatewayApiBaseUrl.mockReturnValue("http://fixture-gateway");
  api.fetchAutonomousActivationGrants.mockImplementation(async () => ({ items: rows }));
  api.revokeAutonomousActivationGrant.mockImplementation(async () => {
    rows = [revoked];
    return revoked;
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected external request");
    }),
  );
});
afterEach(async () => {
  if (view) await act(async () => view?.unmount());
  view = undefined;
  client.clear();
  vi.unstubAllGlobals();
});
it("names the workspace and keeps grant, workspace and project IDs in technical details", async () => {
  preferences.showTechnicalDetails = false;
  await render();
  const card = () => view!.root.findAllByType("li")[0]!;
  expect(text(card().findAllByType("p")[0]!)).not.toContain(grant.workspaceId);
  expect(text(card())).not.toContain(grant.workspaceId);
  expect(text(card())).not.toContain(grant.grantId);
  // The revoke action is named by the row's heading, the grant's reason, never its ID.
  expect(text(button(`Review revocation: ${grant.reason}`))).not.toContain(grant.grantId);
  await act(async () => view!.unmount());
  preferences.showTechnicalDetails = true;
  await render();
  expect(text(card())).toContain(grant.workspaceId);
  expect(text(card())).toContain(grant.grantId);
  preferences.showTechnicalDetails = false;
});

it("links a refused grant load to Settings › Access in the same alert", async () => {
  api.fetchAutonomousActivationGrants.mockImplementation(async () => {
    throw new ApiRequestError("API error 403: forbidden", { kind: "http", method: "GET", path: "/x", status: 403 });
  });
  const navigate = vi.fn();
  await act(async () => {
    view = create(
      <CockpitNavigationContext.Provider
        value={{ isTransitionPending: () => false, navigate, requestTransition: () => undefined }}
      >
        <QueryClientProvider client={client}>
          <AutonomousGrantsSettings workspaceId="workspace-a" />
        </QueryClientProvider>
      </CockpitNavigationContext.Provider>,
    );
  });
  await act(async () => {
    await new Promise((done) => setTimeout(done, 10));
  });
  const alert = view!.root.find((node) => node.props.role === "alert");
  expect(text(alert)).toContain("You don't have permission to do that.");
  expect(text(alert)).not.toContain("API error 403");
  const link = alert.findByType("a");
  expect(text(link)).toBe("Review access in Settings");
  link.props.onClick({ button: 0, preventDefault: () => undefined });
  expect(navigate).toHaveBeenCalledWith("/settings/access#device-access");
});

it("shows exact scope and consequences, cancels with zero writes, then requires canonical revocation", async () => {
  await render();
  await click(`Review revocation: ${grant.reason}`);
  const review = view!.root.findByProps({ role: "dialog" });
  expect(text(review)).toContain(`workspace ${grant.workspaceId}`);
  expect(text(review)).toContain(grant.capabilityPatterns[0]);
  expect(text(review)).toContain("does not prove already-running work stopped");
  expect(text(review)).toContain("is not blocked");
  await click("Keep autonomous grant");
  expect(api.revokeAutonomousActivationGrant).not.toHaveBeenCalled();
  await click(`Review revocation: ${grant.reason}`);
  await click("Revoke reviewed autonomous grant");
  expect(text(view!.root)).toContain("The Gateway confirmed this grant is revoked");
  expect(button(`Review revocation: ${grant.reason}`).props.disabled).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});
it("pages the full installation list and searches exact workspace or grant identity", async () => {
  rows = Array.from({ length: 35 }, (_, index) => ({
    ...grant,
    grantId: `grant-${index}`,
    workspaceId: index === 34 ? "other-workspace" : grant.workspaceId,
  }));
  await render();
  expect(view!.root.findAllByType("li")).toHaveLength(30);
  await click("Show more autonomous grants");
  expect(view!.root.findAllByType("li")).toHaveLength(35);
  await act(async () =>
    view!.root
      .findByProps({ "aria-label": "Find autonomous grant" })
      .props.onChange({ target: { value: "other-workspace" } }),
  );
  expect(view!.root.findAllByType("li")).toHaveLength(1);
  // Search still matches by grant and workspace identity; the ID itself shows under technical details.
  expect(text(view!.root)).not.toContain("grant-34");
  expect(api.revokeAutonomousActivationGrant).not.toHaveBeenCalled();
});
it("keeps an unacknowledged write locked across native remount even if the record now reads revoked", async () => {
  api.revokeAutonomousActivationGrant.mockImplementation(async () => {
    rows = [revoked];
    throw new Error("lost acknowledgement");
  });
  await render();
  await click(`Review revocation: ${grant.reason}`);
  await click("Revoke reviewed autonomous grant");
  await act(async () => view?.unmount());
  view = undefined;
  await render();
  expect(text(view!.root)).toContain("Revocation outcome is uncertain");
  expect(button(`Review revocation: ${grant.reason}`).props.disabled).toBe(true);
  expect(api.revokeAutonomousActivationGrant).toHaveBeenCalledOnce();
});
