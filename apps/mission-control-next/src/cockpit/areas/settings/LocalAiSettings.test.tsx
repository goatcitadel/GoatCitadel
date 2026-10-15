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
    window.history.replaceState(
      { retained: true },
      "",
      "/settings/models?keep=yes&citadelId=fixture&workspaceId=requested&sessionId=carried&shell=cockpit&shellScope=visit#local-ai",
    );
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
    const link = [...container.querySelectorAll("a")].find((item) => item.textContent === "Review required approval")!;
    expect(link).toBeDefined();
    const target = new URL(link.href);
    expect(target.pathname).toBe("/inbox");
    expect(target.searchParams.get("approvalId")).toBe("approval-1");
    expect(target.searchParams.get("workspaceId")).toBe("requested");
    expect(target.searchParams.get("sessionId")).toBe("carried");
    expect(target.searchParams.get("citadelId")).toBe("fixture");
    expect(target.searchParams.get("keep")).toBe("yes");
    expect(target.searchParams.get("shell")).toBe("cockpit");
    expect(target.searchParams.has("shellScope")).toBe(false);
    expect(target.hash).toBe("#local-ai");
    expect(window.history.state.retained).toBe(true);
    expect(api.startLocalAiDownload).toHaveBeenCalledTimes(1);
    expect(api.startLocalAiServe).not.toHaveBeenCalled();
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
  it("keeps every returned model fit selectable in bounded pages without changing the selected request", async () => {
    const model = owner.catalog[0]!,
      recommendation = owner.recommendations[0]!;
    owner.catalog = Array.from({ length: 1000 }, (_, index) => ({
      ...model,
      modelId: `model-${index}`,
      label: `Model ${index}`,
      contextTokens: 8192 + index,
    }));
    owner.recommendations = Array.from({ length: 1000 }, (_, index) => ({
      ...recommendation,
      modelId: `model-${index}`,
      reasons: Array.from({ length: 15 }, (_, reason) => `Model ${index} reason ${reason}`),
    }));
    document.body.appendChild(container);
    await render();
    const select = container.querySelector<HTMLSelectElement>("select")!;
    expect(select.value).toBe(JSON.stringify(["model-0", "llama_cpp"]));
    const next = button("Next model fits");
    next.focus();
    for (let page = 0; page < 12; page++) await click("Next model fits");
    expect(container.querySelector("select")).toBe(select);
    expect(document.activeElement).toBe(next);
    expect(select.options.length).toBeLessThanOrEqual(81);
    expect(select.value).toBe(JSON.stringify(["model-0", "llama_cpp"]));
    expect(container.textContent).toContain("Records 961–1000");
    expect(next.disabled).toBe(true);
    expect(api.fetchLocalAiReadiness).toHaveBeenCalledOnce();
    await act(async () => {
      select.value = JSON.stringify(["model-999", "llama_cpp"]);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).toContain("Model 999 reason 14");
    expect(container.textContent).toContain("9191");
    await click("Request download approval");
    expect(confirmation.message).toContain("model-999");
    await act(async () => confirmation.onCancel());
    expect(api.startLocalAiDownload).not.toHaveBeenCalled();
    expect(api.startLocalAiServe).not.toHaveBeenCalled();
    await click("Previous model fits");
    expect(select.value).toBe(JSON.stringify(["model-999", "llama_cpp"]));
    expect(
      [...container.querySelectorAll("a")].some((link) => new URL(link.href).searchParams.get("shell") === "classic"),
    ).toBe(false);
  });

  it("pages all 1000 hardware records and preserves complete technical measurements without more reads", async () => {
    const runtime = owner.hardware.runtimes[0]!;
    owner.hardware.gpu = Array.from({ length: 1000 }, (_, index) => ({
      name: `GPU ${index}`,
      vendor: `Vendor ${index}`,
      driverVersion: `Driver ${index}`,
      source: "unknown" as const,
    }));
    owner.hardware.runtimes = Array.from({ length: 1000 }, (_, index) => ({
      ...runtime,
      version: `Runtime ${index}`,
      notes: Array.from({ length: 12 }, (_, note) => `Runtime ${index} note ${note}`),
    }));
    document.body.appendChild(container);
    await render();
    await click("Hardware details");
    const panel = container.querySelector('[aria-label="Local hardware"]')!;
    expect(panel.querySelectorAll("ul")[0]!.children).toHaveLength(40);
    expect(panel.querySelectorAll("ul")[1]!.children).toHaveLength(40);
    const nextGpu = button("Next GPU evidence");
    nextGpu.focus();
    for (let page = 0; page < 24; page++) await click("Next GPU evidence");
    expect(document.activeElement).toBe(nextGpu);
    expect(panel.textContent).toContain("GPU records 961–1000 of 1000");
    expect(panel.textContent).toContain("Driver 999");
    expect(panel.textContent).not.toContain("GPU 0");
    for (let page = 0; page < 24; page++) await click("Next Runtime detection");
    expect(panel.textContent).toContain("Runtime 999 note 11");
    expect(panel.querySelectorAll("ul")[1]!.children).toHaveLength(40);
    expect(button("Next Runtime detection").disabled).toBe(true);
    await click("Previous Runtime detection");
    expect(panel.textContent).toContain("Records 921–960");
    expect(api.fetchLocalAiReadiness).toHaveBeenCalledOnce();
    expect(api.startLocalAiDownload).not.toHaveBeenCalled();
    expect(api.startLocalAiServe).not.toHaveBeenCalled();
  });

  it("inspects every 1000-record job and endpoint page with exact approval links and retained metadata", async () => {
    const original = window.location.href,
      state = window.history.state;
    window.history.replaceState(
      { retained: "all-local-ai-evidence" },
      "",
      "/settings/models?workspaceId=requested&citadelId=fixture&runId=carried-run&sessionId=carried-session&extra=one&extra=two#local-ai",
    );
    try {
      owner.downloads = Array.from({ length: 1000 }, (_, index) => ({
        ...localAiJob(),
        jobId: `download-${index}`,
        approvalId: `download approval ${index} /?#`,
        artifactPath: `models/download-${index}.gguf`,
        artifactHash: `hash-${index}`,
      }));
      owner.serveJobs = Array.from({ length: 1000 }, (_, index) => ({
        jobId: `serve-${index}`,
        modelId: "fixture-model",
        backend: "llama_cpp",
        status: "requires_approval",
        approvalId: `serve approval ${index}`,
        endpointUrl: `http://localhost:5000/serve-${index}`,
        processId: 5000 + index,
        createdAt: localAiJob().createdAt,
        updatedAt: localAiJob().updatedAt,
      }));
      owner.endpoints = Array.from({ length: 1000 }, (_, index) => ({
        endpointId: `endpoint-${index}`,
        providerId: `provider-${index}`,
        label: `Endpoint ${index}`,
        backend: "llama_cpp",
        baseUrl: `http://localhost:5000/endpoint-${index}`,
        model: "fixture-model",
        smokeStatus: "pending",
        evidenceRef: `endpoint-evidence-${index}`,
        createdAt: localAiJob().createdAt,
        updatedAt: localAiJob().updatedAt,
      }));
      await render();
      await click("Jobs and endpoints");
      for (const label of ["Downloads", "Serve jobs", "Registered endpoints"]) {
        const panel = container.querySelector(`[aria-label="${label}"]`)!;
        expect(panel.querySelectorAll("li")).toHaveLength(40);
        for (let page = 0; page < 24; page++) await click(`Next ${label}`);
        expect(panel.querySelectorAll("li")).toHaveLength(40);
        expect(panel.textContent).toContain("Records 961–1000");
        expect(button(`Next ${label}`).disabled).toBe(true);
      }
      const downloads = container.querySelector('[aria-label="Downloads"]')!;
      expect(downloads.textContent).toContain("models/download-999.gguf");
      expect(downloads.textContent).toContain("hash-999");
      const links = [...downloads.querySelectorAll<HTMLAnchorElement>("a")];
      expect(links).toHaveLength(40);
      const target = new URL(links.at(-1)!.href);
      expect(target.pathname).toBe("/inbox");
      expect(target.searchParams.get("approvalId")).toBe("download approval 999 /?#");
      expect(target.searchParams.getAll("extra")).toEqual(["one", "two"]);
      expect(target.searchParams.get("runId")).toBe("carried-run");
      expect(target.searchParams.get("sessionId")).toBe("carried-session");
      expect(target.hash).toBe("#local-ai");
      expect(container.querySelector('[aria-label="Serve jobs"]')!.textContent).toContain("5999");
      expect(container.querySelector('[aria-label="Serve jobs"]')!.textContent).toContain(
        "http://localhost:5000/serve-999",
      );
      expect(container.querySelector('[aria-label="Registered endpoints"]')!.textContent).toContain("provider-999");
      expect(container.querySelector('[aria-label="Registered endpoints"]')!.textContent).toContain(
        "endpoint-evidence-999",
      );
      expect(api.fetchLocalAiReadiness).toHaveBeenCalledOnce();
      expect(api.startLocalAiDownload).not.toHaveBeenCalled();
      expect(api.startLocalAiServe).not.toHaveBeenCalled();
      expect(window.history.state.retained).toBe("all-local-ai-evidence");
    } finally {
      window.history.replaceState(state, "", original);
    }
  });
});
