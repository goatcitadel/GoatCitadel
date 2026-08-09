import { useEffect } from "react";
import { create } from "react-test-renderer";
import { describe, expect, it } from "vitest";

import { cleanupTestRenderers } from "./setup";

describe.sequential("react-test-renderer lifecycle", () => {
  let cleanupCount = 0;

  it("registers an effect on a renderer intentionally left mounted", () => {
    function Probe() {
      useEffect(
        () => () => {
          cleanupCount += 1;
        },
        [],
      );
      return null;
    }

    create(<Probe />);
    expect(cleanupCount).toBe(0);
  });

  it("automatically unmounts the prior test renderer before the next test", () => {
    expect(cleanupCount).toBe(1);
  });

  it("finishes renderer cleanup and clears the registry after one unmount fails", () => {
    const calls: string[] = [];
    const renderers = new Set([
      {
        unmount: () => {
          calls.push("first");
          throw new Error("cleanup failed");
        },
      },
      {
        unmount: () => {
          calls.push("second");
        },
      },
    ]);

    expect(() => cleanupTestRenderers(renderers)).toThrow("cleanup failed");
    expect(calls).toEqual(["first", "second"]);
    expect(renderers.size).toBe(0);
  });
});
