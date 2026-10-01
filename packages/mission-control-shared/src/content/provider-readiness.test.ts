import { describe, expect, it } from "vitest";
import { presentProviderReadiness } from "./provider-readiness";

describe("presentProviderReadiness", () => {
  it("distinguishes a live model probe from an unchecked endpoint", () => {
    expect(presentProviderReadiness({ modelProbeState: "ready" })).toEqual({ label: "Connected", tone: "done" });
    expect(presentProviderReadiness({})).toEqual({ label: "Not checked", tone: "neutral" });
  });

  it("prioritizes credential problems over a probe", () => {
    expect(presentProviderReadiness({ authReadiness: { status: "missing" } as never, modelProbeState: "ready" })).toEqual({ label: "Needs setup", tone: "waiting" });
    expect(presentProviderReadiness({ authReadiness: { status: "invalid" } as never })).toEqual({ label: "Key rejected", tone: "failed" });
    expect(presentProviderReadiness({ authReadiness: { status: "unavailable" } as never })).toEqual({ label: "Unavailable", tone: "failed" });
    expect(presentProviderReadiness({ authReadiness: { status: "configured" } as never })).toEqual({ label: "Key saved", tone: "neutral" });
  });

  it("reports local endpoint failures without implying account verification", () => {
    expect(presentProviderReadiness({ modelProbeState: "error" })).toEqual({ label: "Not answering", tone: "failed" });
    expect(presentProviderReadiness({ modelProbeState: "empty" })).toEqual({ label: "No models loaded", tone: "waiting" });
  });
});
