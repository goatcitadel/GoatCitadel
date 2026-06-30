import { describe, expect, it } from "vitest";
import type { CoworkAgenticControlItem } from "@goatcitadel/mission-control-shared/components/cowork-view-model";
import { resolveCoworkComposerStopControl } from "./chat-page-pure-helpers";

const cancelControl: CoworkAgenticControlItem = {
  id: "cancel",
  action: "cancel",
  title: "Cancel",
  enabled: true,
  status: "available",
  runtimeEffect: "state_only",
  note: "Records operator cancel intent for the active cowork run.",
};

describe("resolveCoworkComposerStopControl", () => {
  it("returns the cancel control when a cowork delegation run is running", () => {
    const result = resolveCoworkComposerStopControl({
      mode: "cowork",
      delegationRunStatus: "running",
      controls: [{ id: "pause", action: "pause", title: "Pause", enabled: true }, cancelControl],
    });
    expect(result).toBe(cancelControl);
  });

  it("returns the cancel control even when it is disabled (it is shown disabled, not hidden)", () => {
    const disabledCancel: CoworkAgenticControlItem = { ...cancelControl, enabled: false };
    const result = resolveCoworkComposerStopControl({
      mode: "cowork",
      delegationRunStatus: "running",
      controls: [disabledCancel],
    });
    expect(result).toBe(disabledCancel);
  });

  it("returns null when the delegation run is not running", () => {
    expect(
      resolveCoworkComposerStopControl({
        mode: "cowork",
        delegationRunStatus: "completed",
        controls: [cancelControl],
      }),
    ).toBeNull();
    expect(
      resolveCoworkComposerStopControl({
        mode: "cowork",
        delegationRunStatus: undefined,
        controls: [cancelControl],
      }),
    ).toBeNull();
  });

  it("returns null outside the cowork surface", () => {
    expect(
      resolveCoworkComposerStopControl({
        mode: "chat",
        delegationRunStatus: "running",
        controls: [cancelControl],
      }),
    ).toBeNull();
    expect(
      resolveCoworkComposerStopControl({
        mode: "code",
        delegationRunStatus: "running",
        controls: [cancelControl],
      }),
    ).toBeNull();
  });

  it("returns null when no cancel control is exposed", () => {
    expect(
      resolveCoworkComposerStopControl({
        mode: "cowork",
        delegationRunStatus: "running",
        controls: [{ id: "pause", action: "pause", title: "Pause", enabled: true }],
      }),
    ).toBeNull();
    expect(
      resolveCoworkComposerStopControl({
        mode: "cowork",
        delegationRunStatus: "running",
        controls: undefined,
      }),
    ).toBeNull();
  });
});
