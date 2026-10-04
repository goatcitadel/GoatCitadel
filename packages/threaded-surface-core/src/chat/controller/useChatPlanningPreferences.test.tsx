import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { useChatPlanningPreferences } from "./useChatPlanningPreferences";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Input = Parameters<typeof useChatPlanningPreferences>[0];

function capture(input: Input) {
  let result!: ReturnType<typeof useChatPlanningPreferences>;
  function Probe() {
    result = useChatPlanningPreferences(input);
    return null;
  }
  act(() => {
    create(<Probe />);
  });
  return result;
}

describe("chat planning preferences", () => {
  it("sets every web mode directly, including off", () => {
    const handlePrefPatch = vi.fn(async () => undefined);
    const preferences = capture({
      preferenceActions: { handlePrefPatch } as unknown as Input["preferenceActions"],
      planningMode: "off",
      sessionData: { prefs: { webMode: "auto" } } as unknown as Input["sessionData"],
    });
    for (const mode of ["off", "auto", "quick", "deep"] as const) preferences.handleSetWebMode(mode);
    expect(handlePrefPatch.mock.calls.map(([patch]) => patch)).toEqual([
      { webMode: "off" },
      { webMode: "auto" },
      { webMode: "quick" },
      { webMode: "deep" },
    ]);
  });
});
