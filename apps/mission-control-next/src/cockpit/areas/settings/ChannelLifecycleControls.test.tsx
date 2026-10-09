// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChannelSetupDraft, IntegrationConnection } from "@goatcitadel/contracts";
import { __resetIntegrationConnectionMutationsForTests } from "../../../features/native-routes/settings/integration-connection-mutation";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { setGatewayCallerScope } from "@goatcitadel/mission-control-shared/api/access-scope";
import { __resetChannelMutationStateForTests } from "../../../features/native-routes/settings/sections/channel-setup-state";
import { ChannelLifecycleControls } from "./ChannelLifecycleControls";
import type { Dialog } from "../../ui/Dialog";
const api = vi.hoisted(() => ({ fetchChannelSetupDraft: vi.fn(), discardChannelSetupDraft: vi.fn(), fetchIntegrationConnection: vi.fn(), updateIntegrationConnection: vi.fn(), deleteIntegrationConnection: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (original) => ({
  ...(await original<object>()),
  ...api,
}));
vi.mock("../../ui/Dialog", () => ({
  Dialog: ({ open, title, children }: ComponentProps<typeof Dialog>) =>
    open ? <section aria-label={title}>{children}</section> : null,
}));
let root: Root, container: HTMLDivElement;
const reload = vi.fn();
const draft = {
  draftId: "draft-1",
  catalogId: "channel.telegram",
  revision: 3,
  label: "Reviewed channel",
} as ChannelSetupDraft;
const missing = () =>
  new ApiRequestError("Missing", {
    kind: "http",
    method: "GET",
    path: "/api/v1/channels/drafts/draft-1",
    status: 404,
    body: { code: "ENTITY_NOT_FOUND" },
  });
const button = (name: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === name)!;
async function click(name: string) {
  await act(async () => button(name).click());
}
beforeEach(async () => {
  vi.resetAllMocks();
  __resetChannelMutationStateForTests();
  __resetIntegrationConnectionMutationsForTests();
  setGatewayCallerScope("caller-a");
  window.history.replaceState(null, "", "/settings/connections#channels");
  await new Promise(resolve => setTimeout(resolve, 0));
  api.fetchChannelSetupDraft.mockResolvedValue(draft);
  api.discardChannelSetupDraft.mockResolvedValue({ draftId: draft.draftId, deleted: true });
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () =>
    root.render(<ChannelLifecycleControls workspaceId="a" selection={{ draft }} reload={reload} />),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  setGatewayCallerScope("");
  container.remove();
});
it("reviews, cancels, then verifies canonical deletion before success", async () => {
  await click("Delete saved draft");
  await click("Keep current channel state");
  expect(api.discardChannelSetupDraft).not.toHaveBeenCalled();
  api.fetchChannelSetupDraft.mockResolvedValueOnce(draft).mockRejectedValueOnce(missing());
  await click("Delete saved draft");
  await click("Apply reviewed channel change");
  expect(api.discardChannelSetupDraft).toHaveBeenCalledExactlyOnceWith("draft-1", 3);
  expect(reload).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("Deletion confirmed");
});
it("rejects a changed revision before dispatch", async () => {
  api.fetchChannelSetupDraft.mockResolvedValue({ ...draft, revision: 4 });
  await click("Delete saved draft");
  await click("Apply reviewed channel change");
  expect(api.discardChannelSetupDraft).not.toHaveBeenCalled();
  expect(container.textContent).toContain("could not be confirmed");
});
it("locks ambiguous canonical readback instead of allowing duplicate deletion", async () => {
  await click("Delete saved draft");
  await click("Apply reviewed channel change");
  expect(api.discardChannelSetupDraft).toHaveBeenCalledOnce();
  expect(reload).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Outcome uncertain");
  expect(button("Delete saved draft").disabled).toBe(true);
});
it("does not dispatch after caller handoff during preflight", async () => {
  let finish!: (value: ChannelSetupDraft) => void;
  api.fetchChannelSetupDraft.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await click("Delete saved draft");
  await click("Apply reviewed channel change");
  await act(async () => {
    setGatewayCallerScope("caller-b");
    finish(draft);
  });
  expect(api.discardChannelSetupDraft).not.toHaveBeenCalled();
});

it.each(["disable", "delete"])("reviews and canonically confirms channel connection %s", async action => {
  const connection = { connectionId: "connection-1", catalogId: "channel.telegram", key: "telegram", kind: "channel", label: "Fixture", enabled: true, status: "connected", revision: "a".repeat(64), config: {}, createdAt: "2026-10-06" } as IntegrationConnection;
  const updated = { ...connection, enabled: false, revision: "b".repeat(64) };
  api.fetchIntegrationConnection.mockResolvedValueOnce(connection);
  if (action === "disable") {
    api.updateIntegrationConnection.mockResolvedValue(updated); api.fetchIntegrationConnection.mockResolvedValueOnce(updated);
  } else {
    api.deleteIntegrationConnection.mockResolvedValue({ deleted: true });
    api.fetchIntegrationConnection.mockRejectedValueOnce(new ApiRequestError("Missing", { kind: "http", method: "GET", path: "/api/v1/integrations/connections/connection-1", status: 404, body: { code: "ENTITY_NOT_FOUND" } }));
  }
  await act(async () => root.render(<ChannelLifecycleControls workspaceId="a" selection={{ connection }} reload={reload} />));
  await click(action === "disable" ? "Review disable channel" : "Remove channel connection");
  await click("Apply reviewed channel change");
  if (action === "disable") expect(api.updateIntegrationConnection).toHaveBeenCalledExactlyOnceWith(connection.connectionId, { expectedRevision: connection.revision, enabled: false });
  else expect(api.deleteIntegrationConnection).toHaveBeenCalledExactlyOnceWith(connection.connectionId, connection.revision);
  expect(reload).toHaveBeenCalledOnce();
});
