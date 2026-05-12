import { describe, expect, it } from "vitest";

import * as shared from ".";

describe("mission-control-shared root barrel", () => {
  it("re-exports runtime helpers from the root package entry", () => {
    expect(shared.resolveEffectiveEffectsMode("full")).toBe("full");
    expect(shared.shouldUseReducedEffects()).toBe(false);
    expect(typeof shared.subscribeRefresh).toBe("function");
    expect(typeof shared.publishEventStreamStatus).toBe("function");
  });
});
