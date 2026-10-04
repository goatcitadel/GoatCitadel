import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { AutonomousGrantsSettings } from "./AutonomousGrantsSettings";
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
it("names the workspace and keeps its raw id inside the identity details", async () => {
  await render();
  const card = view!.root.findAllByType("li")[0]!;
  const summaryLine = card.findAllByType("p")[0]!;
  expect(text(summaryLine)).not.toContain(grant.workspaceId);
  expect(text(card)).toContain(grant.workspaceId);
});

it("shows exact scope and consequences, cancels with zero writes, then requires canonical revocation", async () => {
  await render();
  await click(`Review revocation of ${grant.grantId}`);
  const review = view!.root.findByProps({ role: "dialog" });
  expect(text(review)).toContain(`workspace ${grant.workspaceId}`);
  expect(text(review)).toContain(grant.capabilityPatterns[0]);
  expect(text(review)).toContain("does not prove already-running work stopped");
  expect(text(review)).toContain("no atomic revision precondition");
  await click("Keep autonomous grant");
  expect(api.revokeAutonomousActivationGrant).not.toHaveBeenCalled();
  await click(`Review revocation of ${grant.grantId}`);
  await click("Revoke reviewed autonomous grant");
  expect(text(view!.root)).toContain("The Gateway confirmed this grant is revoked");
  expect(button(`Review revocation of ${grant.grantId}`).props.disabled).toBe(true);
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
  expect(text(view!.root)).toContain("grant-34");
  expect(api.revokeAutonomousActivationGrant).not.toHaveBeenCalled();
});
it("keeps an unacknowledged write locked across native remount even if the record now reads revoked", async () => {
  api.revokeAutonomousActivationGrant.mockImplementation(async () => {
    rows = [revoked];
    throw new Error("lost acknowledgement");
  });
  await render();
  await click(`Review revocation of ${grant.grantId}`);
  await click("Revoke reviewed autonomous grant");
  await act(async () => view?.unmount());
  view = undefined;
  await render();
  expect(text(view!.root)).toContain("Revocation outcome is uncertain");
  expect(button(`Review revocation of ${grant.grantId}`).props.disabled).toBe(true);
  expect(api.revokeAutonomousActivationGrant).toHaveBeenCalledOnce();
});
