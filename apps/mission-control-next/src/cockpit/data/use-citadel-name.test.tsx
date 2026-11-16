// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useCitadelName } from "./use-citadel-name";

const citadels = vi.hoisted(() => ({ snapshot: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/citadels", () => ({
  getCitadelStructureSnapshot: citadels.snapshot,
}));

function Probe() {
  return <p>{useCitadelName("citadel-a", true)}</p>;
}

it("reads the loading name with one ellipsis character", async () => {
  citadels.snapshot.mockReturnValue(new Promise(() => undefined));
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Probe />
      </QueryClientProvider>,
    ),
  );
  expect(container.textContent).toBe("Reading Citadel…");
  expect(container.textContent).not.toContain("...");
  act(() => root.unmount());
});
