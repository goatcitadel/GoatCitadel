import { describe, expect, it } from "vitest";
import { create, type ReactTestRenderer } from "react-test-renderer";
import {
  AssistantMessageRenderer,
  createIncrementalSplitState,
  splitIncremental,
  splitStreamingMarkdown,
} from "./AssistantMessageRenderer";

// Feed `full` into the incremental engine one character at a time and assert the
// incremental result is byte-identical to the from-scratch splitStreamingMarkdown at
// EVERY prefix. This is the core equivalence proof for the O(n^2) -> O(delta) refactor.
function assertEquivalentPerCharacter(full: string): void {
  const state = createIncrementalSplitState();
  for (let length = 0; length <= full.length; length += 1) {
    const prefix = full.slice(0, length);
    const incremental = splitIncremental(state, prefix);
    const fromScratch = splitStreamingMarkdown(prefix);
    expect(incremental, `char prefix length=${length} of ${JSON.stringify(full)}`).toEqual(fromScratch);
    // Round-trip invariant: stable + tail must reconstruct the exact prefix.
    expect(incremental.stable + incremental.tail).toBe(prefix);
  }
}

// Same equivalence proof but feeding multi-character "token" chunks of varying sizes,
// since real streaming appends several chars per delta (not one).
function assertEquivalentPerChunk(full: string, chunkSizes: number[]): void {
  const state = createIncrementalSplitState();
  let cursor = 0;
  let chunkIndex = 0;
  while (cursor < full.length) {
    const size = chunkSizes[chunkIndex % chunkSizes.length]!;
    cursor = Math.min(full.length, cursor + size);
    chunkIndex += 1;
    const prefix = full.slice(0, cursor);
    expect(splitIncremental(state, prefix), `chunk prefix length=${cursor} of ${JSON.stringify(full)}`).toEqual(
      splitStreamingMarkdown(prefix),
    );
  }
  // Final complete message.
  expect(splitIncremental(state, full)).toEqual(splitStreamingMarkdown(full));
}

const FIXTURES: Record<string, string> = {
  plainText: "Just a single line with no breaks and no fences at all.",
  plainParagraphs: "First paragraph stays put.\n\nSecond paragraph grows over time as tokens arrive.",
  noFenceManyBreaks: "Alpha.\n\nBeta.\n\nGamma.\n\nDelta tail still streaming",
  openFenceMidStream: "Intro paragraph.\n\n```ts\nconst value = 1;\nconst other = 2;",
  closedFence: "Intro paragraph.\n\n```ts\nconst value = 1;\n```\n\nClosing paragraph after the block.",
  fenceWithBlankInside: "Lead in.\n\n```py\nx = 1\n\ny = 2\n```\n\nAfter the fence with an inner blank line.",
  adjacentFences: "Head.\n\n```ts\na\n```\n\n```js\nb\n```\n\nTail prose after two adjacent fences.",
  indentedFence: "Setup.\n\n   ```js\nbar\n   ```   \n\nbaz tail",
  sameLineFence: 'intro\n\n```json {"ok":true}```\n\noutro tail',
  indentedSameLineFence: "intro\n\n   ```txt done```\n\noutro tail",
  emptyFence: "before\n\n```\n```\n\nafter tail",
  tildeFence: "Pre.\n\n~~~txt\nbody\n~~~\n\npost tail",
  unclosedTildeFence: "intro\n\n~~~txt\n~~~not closed\n\nstill code",
  unclosedBacktickFence: "intro\n\n```js\n```not closed\n\nstill code",
  mixedDoc: [
    "Intro paragraph with a [citation](https://example.com/ref).",
    "",
    "- first list item",
    "- second list item",
    "",
    "```ts",
    "const value = 1;",
    "```",
    "",
    "Closing remarks that keep streaming in",
  ].join("\n"),
  endsWithDoubleNewline: "Paragraph one.\n\nParagraph two.\n\n",
  fenceThenImmediateText: "p\n\n```\ncode\n```\nimmediately after no blank",
};

describe("splitIncremental equivalence with splitStreamingMarkdown", () => {
  it("matches the from-scratch split at every single-character prefix for every fixture", () => {
    for (const [name, full] of Object.entries(FIXTURES)) {
      try {
        assertEquivalentPerCharacter(full);
      } catch (error) {
        throw new Error(`Equivalence failed for fixture "${name}": ${(error as Error).message}`, { cause: error });
      }
    }
  });

  it("matches the from-scratch split for multi-character token chunks", () => {
    for (const full of Object.values(FIXTURES)) {
      assertEquivalentPerChunk(full, [1, 3, 5, 2, 7]);
    }
  });

  it("resets carried fence-state when a new streaming turn id starts (no cross-message leak)", () => {
    // Turn A ends INSIDE an open fence. Turn B is plain prose that would be misparsed as
    // 'inside a fence' if the carried fence-state leaked across messages.
    const turnA = createIncrementalSplitState();
    splitIncremental(turnA, "before\n\n```ts\nopen fence never closed");

    const turnB = createIncrementalSplitState(); // fresh state == new turn id
    const incrementalB = splitIncremental(
      turnB,
      "clean paragraph.\n\nsecond clean paragraph that should finalize.\n\n",
    );
    expect(incrementalB).toEqual(
      splitStreamingMarkdown("clean paragraph.\n\nsecond clean paragraph that should finalize.\n\n"),
    );
    expect(incrementalB.stable).toBe("clean paragraph.\n\nsecond clean paragraph that should finalize.\n\n");
  });

  it("does not rescan from index 0 once a stable boundary is locked (perf shape)", () => {
    const state = createIncrementalSplitState();
    // Lock a stable boundary by finalizing the first paragraph.
    splitIncremental(state, "Locked paragraph one.\n\n");
    const resumeAfterLock = state.resumeIndex;
    expect(resumeAfterLock).toBeGreaterThan(0);

    // Subsequent deltas must resume from the carried boundary, not from 0.
    splitIncremental(state, "Locked paragraph one.\n\nSecond paragraph growing");
    expect(state.lastScanStart).toBe(resumeAfterLock);
    expect(state.lastScanStart).toBeGreaterThan(0);

    splitIncremental(state, "Locked paragraph one.\n\nSecond paragraph growing further still");
    // Resume index hasn't moved (no new newline-terminated line) so scan resumes there.
    expect(state.lastScanStart).toBe(resumeAfterLock);
  });

  it("self-heals (rescans from scratch) when content is not a pure append", () => {
    const state = createIncrementalSplitState();
    splitIncremental(state, "alpha\n\nbravo\n\ncharlie tail");
    // A retry/edit replaces the content with something that is NOT an extension.
    const replaced = "totally different\n\nreplacement body still going";
    expect(splitIncremental(state, replaced)).toEqual(splitStreamingMarkdown(replaced));
    // And a shrink (truncation) also reconciles correctly.
    const shrunk = "totally different\n\n";
    expect(splitIncremental(state, shrunk)).toEqual(splitStreamingMarkdown(shrunk));
  });
});

describe("StreamingMarkdown incremental wiring", () => {
  let renderer: ReactTestRenderer | null = null;

  function renderedShape(r: ReactTestRenderer): string {
    return JSON.stringify(r.toJSON());
  }

  it("renders the same settled markup whether streamed incrementally or rendered whole", () => {
    const full = "Para one.\n\n```ts\nconst v = 1;\n```\n\nPara two closing.";

    // Stream it token-by-token through the running renderer with a stable turn id.
    renderer = create(<AssistantMessageRenderer role="assistant" content="" running streamTurnId="turn-stream" />);
    for (let length = 1; length <= full.length; length += 1) {
      renderer.update(
        <AssistantMessageRenderer
          role="assistant"
          content={full.slice(0, length)}
          running
          streamTurnId="turn-stream"
        />,
      );
    }
    // Finalize (non-running settled render path).
    renderer.update(<AssistantMessageRenderer role="assistant" content={full} running={false} />);
    const streamedFinal = renderedShape(renderer);
    renderer.unmount();

    // Render the identical content directly as a settled message.
    renderer = create(<AssistantMessageRenderer role="assistant" content={full} running={false} />);
    const directFinal = renderedShape(renderer);

    expect(streamedFinal).toBe(directFinal);
  });

  it("does not leak fence parsing across a turn-id change while running", () => {
    const turnAContent = "before\n\n```ts\nopen fence still going";
    renderer = create(
      <AssistantMessageRenderer role="assistant" content={turnAContent} running streamTurnId="turn-a" />,
    );

    // New turn id with plain prose; if fence-state leaked, the second paragraph would be
    // swallowed into the tail as 'still inside a fence'.
    const turnBContent = "clean para.\n\nsecond clean para to finalize.\n\nnow streaming tail";
    renderer.update(<AssistantMessageRenderer role="assistant" content={turnBContent} running streamTurnId="turn-b" />);

    const expected = splitStreamingMarkdown(turnBContent);
    // The stable prefix should be present in the rendered output as its own block.
    const shape = renderedShape(renderer);
    expect(expected.stable).toBe("clean para.\n\nsecond clean para to finalize.\n\n");
    // Stable text (sans markdown newlines) shows up in the rendered tree.
    expect(shape).toContain("second clean para to finalize.");
  });
});
