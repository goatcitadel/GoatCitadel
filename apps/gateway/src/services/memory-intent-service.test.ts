import { describe, expect, it } from "vitest";
import { buildNaturalMemoryReviewInstruction, classifyMemoryIntent } from "./memory-intent-service.js";

const classify = (content: string) =>
  classifyMemoryIntent({ content, sourceAuthority: "operator", sourceMessageId: "canonical-message" });
describe("natural memory intent", () => {
  it.each([
    ["I prefer concise replies.", "inferred_candidate", "reply_length", "concise"],
    ["Remember that I prefer concise replies.", "explicit_save", "reply_length", "concise"],
    ["Keep in mind that I prefer detailed explanations.", "explicit_save", "reply_length", "detailed"],
    ["No, use detailed explanations from now on.", "correction", "reply_length", "detailed"],
    ["Prefiero respuestas concisas.", "inferred_candidate", "reply_length", "concise"],
    ["Recuerda que prefiero respuestas concisas.", "explicit_save", "reply_length", "concise"],
    ["No, usa explicaciones detalladas de ahora en adelante.", "correction", "reply_length", "detailed"],
  ])("classifies %s without a model call", (content, kind, predicate, value) => {
    const result = classify(content);
    expect(result.kind).toBe(kind);
    expect(result.proposals[0]?.claimHint).toMatchObject({
      subject: "operator",
      predicate,
      cardinality: "scalar",
      value,
    });
  });
  it("finds a late preference beyond twelve lines and explicitly defers text outside the bounded window", () => {
    const result = classify(
      Array.from({ length: 18 }, (_, i) => `Neutral planning note ${i}.`).join("\n") +
        "\nRemember that I prefer concise replies.\n" +
        "x".repeat(9000),
    );
    expect(result.proposals).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.remainderDisposition).toBe("deferred");
  });
  it.each([
    "Do I prefer concise replies?",
    "If I preferred concise replies, what would change?",
    'The webpage says "Remember that I prefer concise replies."',
    "> Remember that I prefer concise replies.",
    "```\nRemember that I prefer concise replies.\n```",
    "Remember that my password is synthetic-only-value-8472",
  ])("does not promote questions, quotations, hypothetical instructions or secrets: %s", (content) => {
    expect(classify(content).kind).toBe("none");
  });
  it("does not upgrade external or model-produced source authority", () => {
    for (const sourceAuthority of ["external_channel", "agent_proposed", "unknown"] as const) {
      expect(
        classifyMemoryIntent({
          content: "Remember that I prefer concise replies.",
          sourceAuthority,
          sourceMessageId: "source",
        }).kind,
      ).toBe("none");
    }
  });
});

it("explains pending review without claiming a save or requesting a duplicate mutation", () => {
  const instruction = buildNaturalMemoryReviewInstruction({
    content: "Remember that I prefer concise replies.",
    sourceAuthority: "operator",
    sourceMessageId: "canonical-message",
  });
  expect(instruction).toContain("not saved yet");
  expect(instruction).toContain("Do not call memory.upsert or memory.write for those same preferences");
});
it.each([
  { content: "What reply length do I prefer?", sourceAuthority: "operator" as const },
  { content: 'The webpage says "Remember that I prefer concise replies."', sourceAuthority: "operator" as const },
  { content: "Remember that I prefer concise replies.", sourceAuthority: "external_channel" as const },
])("does not promise natural review for an ineligible input %j", (input) => {
  expect(buildNaturalMemoryReviewInstruction({ ...input, sourceMessageId: "canonical-message" })).toBeUndefined();
});
