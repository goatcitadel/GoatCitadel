// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import type { Sheet } from "../../ui/Sheet";
import { LocalAiSettings } from "./LocalAiSettings";
import { localAiFixture, localAiJob } from "../../../features/native-routes/settings/local-ai.test-support";
import { __resetLocalAiRequestStateForTests } from "../../../features/native-routes/settings/local-ai-request-state";
const api = vi.hoisted(() => ({
  fetchLocalAiReadiness: vi.fn(),
  startLocalAiDownload: vi.fn(),
  startLocalAiServe: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/local-ai", () => api);
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeCitadelId: "fixture" }),
}));
let confirmation: ComponentProps<typeof ConfirmModal>;
vi.mock("@goatcitadel/mission-control-shared/components/ConfirmModal", () => ({
  ConfirmModal: (props: ComponentProps<typeof ConfirmModal>) => {
    confirmation = props;
    return null;
  },
}));
vi.mock("../../ui/Sheet", () => ({
  Sheet: ({ open, title, children }: ComponentProps<typeof Sheet>) =>
    open ? <section aria-label={title}>{children}</section> : null,
}));
let container: HTMLDivElement;
let root: Root;
let owner = localAiFixture();
const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;
async function click(label: string) {
  await act(async () => button(label).click());
}
beforeEach(() => {
  vi.resetAllMocks();
  __resetLocalAiRequestStateForTests();
  owner = localAiFixture();
  api.fetchLocalAiReadiness.mockImplementation(async () => structuredClone(owner));
  api.startLocalAiDownload.mockImplementation(async () => {
    const job = localAiJob();
    owner.downloads.push(job);
    return job;
  });
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const render = () => act(async () => root.render(<LocalAiSettings />));
describe("native Local AI settings", () => {
  it("shows fit limitations and read-only hardware evidence without executing model work", async () => {
    await render();
    expect(container.textContent).toContain("GPU memory not measured");
    expect(container.textContent).toContain("records approval intent only");
    expect(container.querySelectorAll("pre")).toHaveLength(0);
    expect(button("Request download approval").disabled).toBe(false);
    await click("Hardware details");
    expect(container.textContent).toContain("does not establish that the host has no GPU");
    expect(container.textContent).toContain("Version command detected");
    expect(api.startLocalAiDownload).not.toHaveBeenCalled();
    expect(api.startLocalAiServe).not.toHaveBeenCalled();
  });
  it("reviews and cancels without writes, then records the exact intent and links retained approval", async () => {
    await render();
    await click("Request download approval");
    expect(confirmation.open).toBe(true);
    expect(confirmation.message).toContain("does not download a model");
    await act(async () => confirmation.onCancel());
    expect(api.startLocalAiDownload).not.toHaveBeenCalled();
    await click("Request download approval");
    await act(async () => confirmation.onConfirm());
    expect(api.startLocalAiDownload).toHaveBeenCalledExactlyOnceWith({
      modelId: "fixture-model",
      backend: "llama_cpp",
      approvalMode: "request",
    });
    expect(container.textContent).toContain("No model download or server start was performed");
    await click("Jobs and endpoints");
    expect(container.textContent).toContain("requires approval");
    expect(container.textContent).toContain("not a durable execution history");
    expect(
      container.querySelector('a[href="/ops/approvals?shell=classic&approvalId=approval-1&shellScope=visit"]'),
    ).not.toBeNull();
  });
  it("does not claim empty jobs or permit requests when readiness is malformed", async () => {
    api.fetchLocalAiReadiness.mockResolvedValue({});
    await render();
    expect(container.textContent).toContain("Local AI readiness is incomplete");
    expect(container.textContent).not.toContain("No Local AI job endpoint");
    expect(button("Jobs and endpoints").disabled).toBe(true);
    expect(button("Request download approval")).toBeUndefined();
  });
  it("keeps failure evidence and bounded retained records readable", async () => {
    owner.downloads = Array.from({ length: 45 }, (_, index) => ({
      ...localAiJob(),
      jobId: `job-${index}`,
      status: "failed",
      error: "Fixture failure",
    }));
    await render();
    await click("Jobs and endpoints");
    expect(container.textContent).toContain("Showing 40 of 45 retained records");
    expect(
      [...container.querySelectorAll("a")].filter((item) => item.textContent === "Review required approval"),
    ).toHaveLength(40);
    expect(container.textContent).toContain("Fixture failure");
    expect(container.textContent).not.toContain("job-44");
  });
});
