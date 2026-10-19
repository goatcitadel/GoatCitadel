import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import { ThreadedLoadingState } from "./ThreadedLoadingState";

describe("ThreadedLoadingState", () => {
  it("SH-04: titles the loading screen with its heading alone, with no eyebrow above it", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <ThreadedLoadingState
          approvalsCount={0}
          mode="chat"
          projectCount={null}
          sessionCount={2}
          workspaceName="Demo"
        />,
      );
    });
    const copy = renderer.root.findByProps({ className: "mc-next-threaded-loading-copy" });
    expect(copy.findAllByType("p")).toHaveLength(0);
    expect(copy.findByType("h2").children.join("")).toBe("Preparing Chat");
  });
});
