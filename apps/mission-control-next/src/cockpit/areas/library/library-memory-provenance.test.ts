import { expect, it } from "vitest";
import { describeMemoryProvenance } from "./library-memory-provenance";

it("says a memory came from a conversation and names it", () => {
  expect(describeMemoryProvenance({ sourceSessionId: "s-1" })).toEqual({
    lines: ["Remembered from a conversation."],
    conversationId: "s-1",
  });
});
it("ignores a blank conversation id", () => {
  expect(describeMemoryProvenance({ sourceSessionId: "  " })).toEqual({
    lines: ["No source was recorded for this item."],
  });
});
it.each([
  ["approved_memory_lifecycle", "Saved through a change you approved."],
  ["scheduler", "Saved by a scheduled job."],
  ["memory_context", "Saved from conversation context."],
])("explains the %s source", (source, line) => {
  expect(describeMemoryProvenance({ source }).lines).toEqual([line]);
});
it("combines the conversation and the source in order", () => {
  expect(describeMemoryProvenance({ sourceSessionId: "s-1", source: "approved_memory_lifecycle" })).toEqual({
    lines: ["Remembered from a conversation.", "Saved through a change you approved."],
    conversationId: "s-1",
  });
});
it("points at the identifiers when only an unknown source was recorded", () => {
  expect(describeMemoryProvenance({ source: "something_else" }).lines).toEqual([
    "A source was recorded. Its details are under Memory source identifiers.",
  ]);
  expect(describeMemoryProvenance({ actorId: "operator" }).lines).toEqual([
    "A source was recorded. Its details are under Memory source identifiers.",
  ]);
});
it("says nothing was recorded when there is no source", () => {
  expect(describeMemoryProvenance({}).lines).toEqual(["No source was recorded for this item."]);
  expect(describeMemoryProvenance({ source: 4 }).lines).toEqual(["No source was recorded for this item."]);
});
