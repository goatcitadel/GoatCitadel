// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DesktopUpdateStatus } from "@goatcitadel/contracts";
import { createEmptyLlmTransportDraft } from "@goatcitadel/mission-control-shared/components/LlmTransportFields";
import { notifyGatewayAccessChanged } from "@goatcitadel/mission-control-shared/api/access-scope";
import { createEmptyProviderEditorDraft } from "../../../features/native-routes/settings/helpers/provider-drafts";
import { ProviderProfileReview } from "./ProviderProfileReview";
import { DesktopUpdateSettings } from "./DesktopUpdateSettings";
const host = vi.hoisted(() => ({ status: null as DesktopUpdateStatus | null, act: vi.fn() }));
vi.mock("../../../features/desktop-updates/desktop-update-bridge", () => ({ useDesktopUpdates: () => host.status }));
vi.mock("../../../features/desktop-updates/use-desktop-update-actions", () => ({
  useDesktopUpdateActions: () => ({ act: host.act, busy: false, uncertain: false }),
}));
let root: Root, element: HTMLDivElement;
const button = (label: string) => [...document.querySelectorAll("button")].find((item) => item.textContent === label)!;
beforeEach(() => {
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
  host.act.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
});
it("reviews unsigned Preview, cancels without host writes, and rejects a changed installed version", async () => {
  host.status = {
    channel: "stable",
    phase: "idle",
    installedVersion: "1.0",
    installedCommit: "a",
    message: "Ready",
    downloadedBytes: 0,
    downloadedPath: null,
    nextCheckAt: null,
    snoozedUntil: null,
    lastSuccessfulCheck: null,
    availableRelease: null,
  };
  await act(async () => root.render(<DesktopUpdateSettings />));
  const choose = () => {
    const select = element.querySelector("select")!;
    select.value = "preview";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  };
  await act(async () => choose());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("unsigned");
  expect(host.act).not.toHaveBeenCalled();
  await act(async () => button("Keep current channel").click());
  expect(host.act).not.toHaveBeenCalled();
  await act(async () => choose());
  host.status = { ...host.status, installedVersion: "2.0" };
  await act(async () => root.render(<DesktopUpdateSettings />));
  expect(button("Use reviewed Preview channel").disabled).toBe(true);
  expect(host.act).not.toHaveBeenCalled();
});
it("keeps TLS consequences outside disclosure and closes authorization review on credential change", async () => {
  const transport = createEmptyLlmTransportDraft();
  transport.tls.insecureSkipVerify = true;
  const onConfirm = vi.fn(),
    onCancel = vi.fn();
  const draft = {
    provider: { ...createEmptyProviderEditorDraft(), providerId: "fixture", baseUrl: "https://model.invalid" },
    transport,
  };
  await act(async () =>
    root.render(
      <ProviderProfileReview
        draft={draft}
        kind="transport"
        revision={4}
        current
        busy={false}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    ),
  );
  const alert = document.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain("prompts, responses and credentials");
  expect(alert.textContent).toContain("https://model.invalid");
  expect(alert.closest("details")).toBeNull();
  await act(async () => notifyGatewayAccessChanged());
  expect(document.querySelector('[role="dialog"][data-state="open"]')).toBeNull();
  expect(onCancel).toHaveBeenCalled();
  expect(onConfirm).not.toHaveBeenCalled();
});
