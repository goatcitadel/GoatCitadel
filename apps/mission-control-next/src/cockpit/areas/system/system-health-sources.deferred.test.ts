import { expect, it, vi } from "vitest";
import { loadSystemHealthDigest, loadSystemHealthSources } from "./system-health-sources";

const fixture = vi.hoisted(() => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    held,
    release,
    revision: 0,
    summary: vi.fn().mockResolvedValue({}),
    start: vi.fn(),
    detailed: vi.fn(),
    sources: vi.fn(),
  };
});

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ fetchHealthSummary: fixture.summary }));
vi.mock("@goatcitadel/mission-control-shared/api/access-scope", () => ({
  getGatewayAccessRevision: () => fixture.revision,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => "http://health.invalid",
}));
vi.mock("./system-health-source-details", async () => {
  fixture.start();
  await fixture.held;
  return { loadDetailedHealthDigest: fixture.detailed, loadDetailedHealthSources: fixture.sources };
});

it("keeps core status independent of detailed transport and skips reads retired while loading", async () => {
  try {
    const core = await loadSystemHealthDigest(undefined, { deferOptionalSources: true });
    expect(core.summary.state).toBe("current");
    expect(core.channels.state).toBe("deferred");
    expect(fixture.summary).toHaveBeenCalledOnce();
    expect(fixture.start).not.toHaveBeenCalled();

    const controller = new AbortController();
    const cancelled = loadSystemHealthSources("retired-workspace", undefined, controller.signal);
    const replaced = loadSystemHealthDigest();
    await vi.waitFor(() => expect(fixture.start).toHaveBeenCalledOnce());
    controller.abort();
    fixture.revision += 1;
    const current = loadSystemHealthSources("current-workspace", core);
    const cancellation = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    const replacement = expect(replaced).rejects.toMatchObject({ name: "AbortError" });
    fixture.release();
    await Promise.all([cancellation, replacement, current]);

    expect(fixture.detailed).not.toHaveBeenCalled();
    expect(fixture.sources).toHaveBeenCalledExactlyOnceWith("current-workspace", core);
  } finally {
    fixture.release();
  }
});
