import { describe, expect, it } from "vitest";
import { createInlineReasoningSplitter, splitInlineReasoning } from "./inline-reasoning.js";

function streamAll(pieces: string[]): { answer: string; reasoning: string } {
  const splitter = createInlineReasoningSplitter();
  const parts = [...pieces.map((piece) => splitter.push(piece)), splitter.flush()];
  return {
    answer: parts.map((part) => part.answer).join(""),
    reasoning: parts.map((part) => part.reasoning).join(""),
  };
}

describe("inline reasoning splitter", () => {
  it.each(["think", "thinking", "analysis", "reasoning", "THINK"])("moves a leading <%s> block to reasoning", (tag) => {
    expect(splitInlineReasoning(`\n<${tag}>weighing options</${tag}>\n\nAnswer.`)).toEqual({
      answer: "Answer.",
      reasoning: "weighing options",
    });
  });

  it("gives the same split however the stream is chunked", () => {
    const text = '<think type="x">a < b, so</think >  <thinking>more</thinking>Final <think>kept</think>';
    const expected = { answer: "Final <think>kept</think>", reasoning: "a < b, somore" };
    expect(streamAll([text])).toEqual(expected);
    expect(streamAll([...text])).toEqual(expected);
  });

  it("holds a half-arrived opening tag, then releases non-reasoning text unchanged", () => {
    const splitter = createInlineReasoningSplitter();
    expect(splitter.push("  <thin")).toEqual({ answer: "", reasoning: "" });
    expect(splitter.push("gs to do")).toEqual({ answer: "<things to do", reasoning: "" });
    expect(splitter.push(" today")).toEqual({ answer: " today", reasoning: "" });
  });

  it("stops holding an unterminated opening tag after a bounded length", () => {
    const long = `<think ${"x".repeat(80)}`;
    expect(streamAll([long])).toEqual({ answer: long, reasoning: "" });
  });

  it("leaves prose and code that merely mention the tags alone", () => {
    expect(splitInlineReasoning("Wrap it in <think> tags.")).toEqual({
      answer: "Wrap it in <think> tags.",
      reasoning: "",
    });
    expect(splitInlineReasoning("<div>hi</div>")).toEqual({ answer: "<div>hi</div>", reasoning: "" });
  });

  it("treats a reply cut off inside the reasoning block as reasoning only", () => {
    expect(streamAll(["<think>still ", "going</th"])).toEqual({ answer: "", reasoning: "still going</th" });
  });
});
