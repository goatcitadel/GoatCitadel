import React from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSurfaceClassifyPreview } from "./useSurfaceClassifyPreview";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { classifySurfaceMode } = vi.hoisted(() => ({
  classifySurfaceMode: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({
  classifySurfaceMode: (...args: unknown[]) => classifySurfaceMode(...args),
}));

const CODE_RESPONSE = {
  mode: "code" as const,
  confidence: 0.85,
  source: "heuristic" as const,
  rationale: "x",
  alternatives: [] as const,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("useSurfaceClassifyPreview", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    classifySurfaceMode.mockReset();
  });

  it("returns the classification for a new thread after debounce", async () => {
    classifySurfaceMode.mockResolvedValue(CODE_RESPONSE);

    let latest: ReturnType<typeof useSurfaceClassifyPreview> | undefined;
    function Harness() {
      latest = useSurfaceClassifyPreview({
        draft: "write a python script",
        enabled: true,
        hasBoundProject: false,
      });
      return null;
    }

    act(() => {
      create(<Harness />);
    });

    expect(latest).toBeUndefined();
    expect(classifySurfaceMode).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(350);
    });
    // flush the resolved promise
    await act(async () => {
      await Promise.resolve();
    });

    expect(classifySurfaceMode).toHaveBeenCalledTimes(1);
    expect(latest?.mode).toBe("code");
    expect(latest?.confidence).toBe(0.85);
  });

  it("is inert when disabled (existing/resolved thread): never calls classify, returns undefined", async () => {
    classifySurfaceMode.mockResolvedValue(CODE_RESPONSE);

    let latest: ReturnType<typeof useSurfaceClassifyPreview> | undefined;
    function Harness() {
      latest = useSurfaceClassifyPreview({
        draft: "write a long script",
        enabled: false,
        hasBoundProject: false,
      });
      return null;
    }

    act(() => {
      create(<Harness />);
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(classifySurfaceMode).not.toHaveBeenCalled();
    expect(latest).toBeUndefined();
  });

  it("is inert for very short drafts (<3 chars)", async () => {
    classifySurfaceMode.mockResolvedValue(CODE_RESPONSE);

    let latest: ReturnType<typeof useSurfaceClassifyPreview> | undefined;
    function Harness() {
      latest = useSurfaceClassifyPreview({
        draft: "hi",
        enabled: true,
        hasBoundProject: false,
      });
      return null;
    }

    act(() => {
      create(<Harness />);
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(classifySurfaceMode).not.toHaveBeenCalled();
    expect(latest).toBeUndefined();
  });

  it("fails open: a classify rejection yields undefined and does not throw", async () => {
    classifySurfaceMode.mockRejectedValue(new Error("network down"));

    let latest: ReturnType<typeof useSurfaceClassifyPreview> | undefined;

    function Harness() {
      latest = useSurfaceClassifyPreview({
        draft: "write a python script",
        enabled: true,
        hasBoundProject: false,
      });
      return null;
    }

    act(() => {
      create(<Harness />);
    });
    act(() => {
      vi.advanceTimersByTime(350);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(classifySurfaceMode).toHaveBeenCalledTimes(1);
    expect(latest).toBeUndefined();
  });
});
