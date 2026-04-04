import { describe, expect, it } from "vitest";
import { resolveMissionControlDockSectionOrder } from "./useMissionControlSurfaceState";

describe("resolveMissionControlDockSectionOrder", () => {
  it("prioritizes trace context first on chat when the selected turn needs intervention", () => {
    expect(resolveMissionControlDockSectionOrder({
      mode: "chat",
      showTracePanel: true,
      showSuggestionsPanel: true,
      showLearnedMemoryPanel: true,
      hasExternalBindingSection: false,
      hasBlockingContext: true,
      hasDelegationSuggestion: false,
      codeModeNeedsProjectBinding: false,
    })).toEqual(["trace", "surface", "suggestions", "memory", "session"]);
  });

  it("keeps cowork workflow context ahead of supporting sections", () => {
    expect(resolveMissionControlDockSectionOrder({
      mode: "cowork",
      showTracePanel: true,
      showSuggestionsPanel: true,
      showLearnedMemoryPanel: true,
      hasExternalBindingSection: false,
      hasBlockingContext: false,
      hasDelegationSuggestion: true,
      codeModeNeedsProjectBinding: false,
    }).slice(0, 3)).toEqual(["suggestions", "workflow", "surface"]);
  });

  it("pushes code posture and workbench ahead of the rest when project binding is missing", () => {
    expect(resolveMissionControlDockSectionOrder({
      mode: "code",
      showTracePanel: true,
      showSuggestionsPanel: false,
      showLearnedMemoryPanel: false,
      hasExternalBindingSection: false,
      hasBlockingContext: false,
      hasDelegationSuggestion: false,
      codeModeNeedsProjectBinding: true,
    })).toEqual(["surface", "workflow", "trace", "session"]);
  });
});
