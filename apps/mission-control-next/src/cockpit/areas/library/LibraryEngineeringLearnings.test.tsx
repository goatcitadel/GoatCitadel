// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/settings";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { LibraryEngineeringLearnings } from "./LibraryEngineeringLearnings";

vi.mock("@goatcitadel/mission-control-shared/api/settings", () => ({ fetchSettings: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/engineering-learnings", () => ({
  fetchEngineeringLearning: vi.fn(),
  fetchEngineeringLearnings: vi.fn().mockResolvedValue({ items: [] }),
  requestEngineeringLearningAction: vi.fn(),
}));

let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  vi.mocked(fetchSettings).mockReset();
  window.history.replaceState(null, "", "/library/knowledge?shell=cockpit");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
});

it("says engineering learnings is turned off and links to its switch", async () => {
  vi.mocked(fetchSettings).mockResolvedValue({ features: { engineeringLearningsV1Enabled: false } } as Awaited<
    ReturnType<typeof fetchSettings>
  >);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>
          <LibraryEngineeringLearnings workspaceId="one" />
        </CockpitNavigationProvider>
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() =>
    expect(container.textContent).toContain("Engineering learnings is turned off on this installation."),
  );
  expect(container.textContent).not.toContain("Direct links and technical details do not enable this feature.");
  const link = [...container.querySelectorAll("a")].find(
    (entry) => entry.textContent === "Turn it on in Settings › Advanced",
  );
  expect(new URL(link!.getAttribute("href")!, "http://cockpit.invalid").hash).toBe(
    "#feature-switch-engineering-learnings",
  );
});
