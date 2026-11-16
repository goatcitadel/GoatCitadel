// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CapabilityCatalog } from "./CapabilityCatalog";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    isError: true,
    isLoading: false,
    isFetching: false,
    error: new Error("Owner unavailable"),
    data: undefined,
    refetch: vi.fn(),
  }),
}));
vi.mock("@goatcitadel/mission-control-shared/hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));

it("says what the Library landing page holds and where the rest is (U-LB-007)", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<CapabilityCatalog />));
    expect(container.textContent).toContain(
      "Skill candidates and what mesh nodes publish. Memory, notes, files and the rest are in the tabs above.",
    );
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
