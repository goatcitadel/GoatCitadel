import { useEffect } from "react";
import { create } from "react-test-renderer";
import { describe, expect, it } from "vitest";

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
});
