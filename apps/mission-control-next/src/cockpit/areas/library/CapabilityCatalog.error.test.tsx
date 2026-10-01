// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { CapabilityCatalog } from "./CapabilityCatalog";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    isError: true,
    isLoading: false,
    isFetching: false,
    error: new Error("Owner unavailable"),
    data: { items: [{ capabilityId: "private-stale-item", name: "Stale capability" }],
      callableKnown: true, skillsKnown: true, issues: [] },
    refetch: vi.fn(),
  }),
}));
vi.mock("@goatcitadel/mission-control-shared/hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));

describe("capability catalog owner refresh", () => {
  it("withholds cached catalog entries after a failed owner read", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<CapabilityCatalog />));
      expect(container.textContent).toContain("Library unavailable");
      expect(container.textContent).not.toContain("Stale capability");
      expect(container.textContent).not.toContain("capabilities shown");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
