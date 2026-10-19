// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingState } from "@goatcitadel/contracts";
import { onboardingFixture } from "../../../features/native-routes/settings/onboarding.test-support";
import { FirstRunStatus } from "./FirstRunStatus";

const api = vi.hoisted(() => ({ fetchOnboardingState: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ ...api, isApiRequestError: () => false }));
vi.mock("../../ui/NativeOwnerLink", () => ({
  NativeOwnerLink: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

let root: Root, container: HTMLDivElement, client: QueryClient, owner: OnboardingState;
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <FirstRunStatus />
      </QueryClientProvider>,
    ),
  );
}
const rows = () => [...container.querySelectorAll('ol[aria-label="Setup progress"] > li')].map((li) => li.textContent);
beforeEach(() => {
  vi.resetAllMocks();
  owner = onboardingFixture();
  api.fetchOnboardingState.mockImplementation(async () => structuredClone(owner));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

describe("Settings › Get started status (ST-03)", () => {
  it("shows a compact status and a link to setup instead of the full first-run page", async () => {
    await render();
    await vi.waitFor(() => expect(rows()).toHaveLength(3));
    expect(rows()).toEqual([
      expect.stringMatching(/^Step 1: Choose a model.*Provider A.*Done$/u),
      expect.stringMatching(/^Step 2: Choose your safety settings.*Current$/u),
      expect.stringMatching(/^Step 3: Send a test message.*Not started$/u),
    ]);
    expect(container.textContent).toContain("Setup isn't finished");
    const link = container.querySelector("a")!;
    expect(link.textContent).toBe("Open setup");
    expect(link.getAttribute("href")).toBe("/settings/first-run");
    expect(container.querySelector("h1, nav, select")).toBeNull();
    expect(container.textContent).not.toContain("Exit setup");
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
  it("reports a recorded setup and leaves only the test message open", async () => {
    owner = { ...owner, completed: true, completedAt: "2026-09-30T00:00:00.000Z", completedBy: "operator" };
    await render();
    await vi.waitFor(() => expect(rows()).toHaveLength(3));
    expect(rows()[1]).toMatch(/Tool approval:.*Done$/u);
    expect(rows()[2]).toMatch(/Current$/u);
    expect(container.textContent).toContain("Setup is recorded");
  });
  it("says when progress cannot be read and offers a retry", async () => {
    api.fetchOnboardingState.mockRejectedValue(new Error("offline"));
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Setup progress is unavailable"));
    expect(container.querySelector("button")?.textContent).toBe("Try again");
    expect(container.querySelector("a")?.textContent).toBe("Open setup");
  });
});
