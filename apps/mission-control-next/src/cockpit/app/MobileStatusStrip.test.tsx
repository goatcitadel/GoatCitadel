// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileStatusStrip } from "./MobileStatusStrip";

const health = vi.hoisted(() => ({ digest: vi.fn() }));
vi.mock("../areas/system/system-health-sources", async (importOriginal) => ({ ...(await importOriginal<typeof import("../areas/system/system-health-sources")>()), loadSystemHealthDigest: health.digest }));
vi.mock("../data/use-operator-inbox", () => ({ useOperatorInbox: () => ({ data: undefined, isError: false }) }));
vi.mock("../../features/desktop-updates/desktop-update-bridge", () => ({ useDesktopUpdates: () => null }));

const unavailable = { state: "unavailable", detail: "Unavailable" } as const;
let root: Root, container: HTMLDivElement, client: QueryClient;

beforeEach(() => {
  health.digest.mockReset().mockResolvedValue({
    summary: unavailable,
    llama: unavailable,
    npu: unavailable,
    connections: unavailable,
    channels: { state: "deferred" },
    workers: { state: "deferred" },
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

describe("MobileStatusStrip", () => {
  it("names both dots in text and titles, never by colour alone", async () => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <MobileStatusStrip workspaceId="w" streamState="retrying" />
        </QueryClientProvider>,
      ),
    );
    const strip = container.querySelector<HTMLElement>('[aria-label="System status"]')!;
    expect(strip.textContent).toContain("Checking system…");
    expect(strip.textContent).toContain("Reconnecting to updates");
    await vi.waitFor(() => expect(strip.textContent).toContain("Some system checks lack live proof"));
    const healthDot = strip.querySelector<HTMLElement>("[data-health-tone]")!;
    expect(healthDot.title).toContain("Managed local runtimes, integrations, channels and workers are checked on System › Health.");
    expect(healthDot.querySelector(".sr-only")?.textContent).toBe("Core checks · Some system checks lack live proof");
    const stream = strip.querySelector<HTMLElement>("[data-stream-state]")!;
    expect(stream.title).toBe("Reconnecting to updates");
    expect(stream.querySelector(".sr-only")?.textContent).toBe("Reconnecting to updates");
    expect(health.digest).toHaveBeenCalledTimes(1);
  });
});

it("exposes replay recovery and transport degradation accessibly",async()=>{
 await act(async()=>root.render(<QueryClientProvider client={client}><MobileStatusStrip workspaceId="w" streamState="open" replayRecovery/></QueryClientProvider>));
 expect(container.querySelector('[data-stream-state="open"]')?.getAttribute("aria-label")).toBe("Live updates: Streaming (replay recovery)");
 expect(container.textContent).toContain("Replay recovery");
 await act(async()=>root.render(<QueryClientProvider client={client}><MobileStatusStrip workspaceId="w" streamState="retrying" replayRecovery/></QueryClientProvider>));
 expect(container.querySelector('[data-stream-state="retrying"]')?.getAttribute("aria-label")).toBe("Live updates: Polling fallback");
 expect(container.textContent).toContain("Reconnecting to updates");
});
