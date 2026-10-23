// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReleaseReadinessSection } from "./ReleaseReadinessSection";

const preferences = vi.hoisted(() => ({ showTechnicalDetails: false }));
const api = vi.hoisted(() => ({ fetchReviewReadiness: vi.fn(), refreshRuntimeReleaseTrust: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => preferences }));
vi.mock("@goatcitadel/mission-control-shared/api/review-readiness", () => api);

const summary = {
  branch: "main",
  sha: "abcdef1234567890",
  generatedAt: "2026-10-23T08:00:00Z",
  lanes: [{ lane: "docs:check", status: "current", rerunHint: "pnpm docs:check" }],
  openFindings: 0,
  linkedTasks: [],
  runtimeIdentity: {
    schemaVersion: 1,
    kind: "source",
    version: "1.0.0",
    integrity: "clean",
    identitySource: "git_checkout",
    release: {
      verified: false,
      certificateState: "parsed",
      requiredProof: { total: 2, passed: 1, missing: 1, failed: 0, stale: 0 },
      acceptedFailureCount: 0,
      acceptedFailures: [],
      certificateAttestation: { status: "missing" },
      runtimePayloadIntegrity: { status: "unverified" },
      reasonCodes: ["required_proof_missing"],
      reasons: ["A required check has not run."],
    },
  },
};
let host: HTMLDivElement, root: Root, client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  api.fetchReviewReadiness.mockResolvedValue(summary);
  api.refreshRuntimeReleaseTrust.mockResolvedValue({ ...summary, openFindings: 3 });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  client.clear();
});
const render = () =>
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <ReleaseReadinessSection />
      </QueryClientProvider>,
    ),
  );
const open = async () => {
  const details = host.querySelector("details")!;
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
  await vi.waitFor(() => expect(host.textContent).toContain("Blocked"));
};

it("reads nothing until the section is opened, then reads once", async () => {
  render();
  expect(host.querySelector("summary")?.textContent).toBe("Release and review readiness");
  expect(api.fetchReviewReadiness).not.toHaveBeenCalled();
  await open();
  expect(api.fetchReviewReadiness).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("A required check has not run.");
  expect(host.textContent).not.toContain("abcdef12");
  expect(host.textContent).not.toContain("required_proof_missing");
});

it("checks again through the release refresh and shows its result", async () => {
  render();
  await open();
  const again = [...host.querySelectorAll("button")].find((node) => node.textContent === "Check again")!;
  await act(async () => again.click());
  await vi.waitFor(() => expect(host.textContent).toContain("3 open review findings"));
  expect(api.refreshRuntimeReleaseTrust).toHaveBeenCalledTimes(1);
});
