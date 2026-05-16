import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAddonSlots } from "./useAddonSlots";

const apiMocks = vi.hoisted(() => ({
  fetchAddonSlots: vi.fn(),
}));

vi.mock("../api/platform.js", () => ({
  fetchAddonSlots: apiMocks.fetchAddonSlots,
}));

type HookValue = ReturnType<typeof useAddonSlots>;

function Harness({
  route,
  slot,
  enabled,
  onValue,
}: {
  route?: string;
  slot?: Parameters<typeof useAddonSlots>[1];
  enabled?: boolean;
  onValue: (value: HookValue) => void;
}) {
  const value = useAddonSlots(route, slot, { enabled });
  onValue(value);
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useAddonSlots", () => {
  let renderer: ReactTestRenderer | null = null;
  let latest: HookValue | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    latest = null;
  });

  afterEach(() => {
    renderer?.unmount();
    renderer = null;
  });

  it("loads addon slot registrations on mount and forwards route + slot filters", async () => {
    apiMocks.fetchAddonSlots.mockResolvedValueOnce({
      items: [{ addonId: "alpha", slot: "ops.approvals.actions", route: "/ops/approvals" }],
    });

    await act(async () => {
      renderer = create(
        <Harness
          route="/ops/approvals"
          slot="ops.approvals.actions"
          onValue={(value) => {
            latest = value;
          }}
        />,
      );
    });
    await flush();

    expect(apiMocks.fetchAddonSlots).toHaveBeenCalledWith({
      route: "/ops/approvals",
      slot: "ops.approvals.actions",
    });
    expect(latest?.loading).toBe(false);
    expect(latest?.error).toBeNull();
    expect(latest?.items).toEqual([{ addonId: "alpha", slot: "ops.approvals.actions", route: "/ops/approvals" }]);
  });

  it("surfaces fetch errors without crashing and exposes a refresh handle", async () => {
    apiMocks.fetchAddonSlots.mockRejectedValueOnce(new Error("network down"));

    await act(async () => {
      renderer = create(
        <Harness
          onValue={(value) => {
            latest = value;
          }}
        />,
      );
    });
    await flush();

    expect(latest?.error).toBe("network down");
    expect(latest?.items).toEqual([]);

    apiMocks.fetchAddonSlots.mockResolvedValueOnce({
      items: [{ addonId: "beta", slot: "library.skills.cards" }],
    });
    await act(async () => {
      await latest?.refresh();
    });
    await flush();
    expect(latest?.items).toEqual([{ addonId: "beta", slot: "library.skills.cards" }]);
    expect(latest?.error).toBeNull();
  });

  it("does not fetch when disabled", async () => {
    await act(async () => {
      renderer = create(
        <Harness
          enabled={false}
          onValue={(value) => {
            latest = value;
          }}
        />,
      );
    });
    await flush();

    expect(apiMocks.fetchAddonSlots).not.toHaveBeenCalled();
    expect(latest?.items).toEqual([]);
    expect(latest?.loading).toBe(false);
  });
});
