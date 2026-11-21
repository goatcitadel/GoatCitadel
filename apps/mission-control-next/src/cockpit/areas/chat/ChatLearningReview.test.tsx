// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import type { TraceMemoryCandidateRecord, TurnLearningReceipt } from "@goatcitadel/contracts";
import { ChatLearningReview } from "./ChatLearningReview";
import { ChatLearningReceipt } from "./ChatLearningReceipt";
let tree: ReactTestRenderer;
afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
});
const candidate = {
  candidateId: "c",
  workspaceId: "A",
  reviewHash: "a".repeat(64),
  status: "proposed",
  proposedInsight: "Use reproducible checks",
  sourceText: "Completed project work",
  sourceRefs: [],
  editEligibility: { allowed: true },
} as unknown as TraceMemoryCandidateRecord;
it("offers the exact lesson and direct save/reject without a redundant confirmation or automatic submission", async () => {
  const decide = vi.fn();
  await act(async () => {
    tree = create(<ChatLearningReview candidate={candidate} onDecision={decide} />);
  });
  expect(decide).not.toHaveBeenCalled();
  expect(JSON.stringify(tree.toJSON())).toContain(candidate.proposedInsight);
  await act(async () => tree.root.findByProps({ "data-learning-save": true }).props.onClick());
  expect(decide).toHaveBeenCalledWith(candidate, "promote");
});
it("keeps saved, recall-ready and actually-used evidence separate", async () => {
  const receipt = {
    proposals: [],
    applied: [{ kind: "memory", ref: "saved", state: "saved_not_ready", href: "/library/memory" }],
    usedSources: [
      { kind: "skill", ref: "admitted", sourceHash: "b".repeat(64), state: "used_in_turn", href: "/capabilities" },
    ],
    jobs: [],
    warnings: [],
  } as unknown as TurnLearningReceipt;
  await act(async () => {
    tree = create(<ChatLearningReceipt receipt={receipt} onDecision={vi.fn()} />);
  });
  const text = JSON.stringify(tree.toJSON());
  expect(text).toContain("Saved; recall is not ready");
  expect(text).toContain("Admitted in this turn");
  expect(text).not.toContain("Getting smarter");
});
it("shows the owner clarification before a refused save and keeps rejection available", async () => {
  const clarification = {
    ...candidate,
    promotionEligibility: {
      allowed: false,
      reason: "Which saved preference should this replace? Name the preference in Chat to prepare a fresh correction.",
    },
  };
  await act(async () => {
    tree = create(<ChatLearningReview candidate={clarification} onDecision={vi.fn()} />);
  });
  expect(JSON.stringify(tree.toJSON())).toContain("Which saved preference should this replace?");
  expect(tree.root.findByProps({ "data-learning-save": true }).props.disabled).toBe(true);
  expect(tree.root.findAllByType("button").find((button) => button.children.includes("Reject"))?.props.disabled).toBe(
    false,
  );
});
