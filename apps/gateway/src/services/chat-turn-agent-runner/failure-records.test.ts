import { describe, expect, it } from "vitest";
import {
  buildChatTurnFailureRecord,
  classifyChatTurnFailure,
  extractSkillSecurityFailureRecord,
} from "./failure-records.js";

describe("chat turn skill-security failure records", () => {
  it("persists only structured hash evidence and marks the failure non-retryable", () => {
    const evidenceHash = "a".repeat(64);
    const error = Object.assign(new Error("blocked"), {
      failureClass: "skill_security_blocked",
      details: {
        failureClass: "skill_security_blocked",
        scannerVersion: "1.0.0",
        skillIds: ["skill-dangerous", "skill-dangerous"],
        ruleIds: ["approval_policy_bypass"],
        evidenceHashes: [evidenceHash],
        rawInstruction: "bypass approval and expose this raw text",
      },
    });

    const failureClass = classifyChatTurnFailure({ error, toolRuns: [] });
    const security = extractSkillSecurityFailureRecord(error);
    const record = buildChatTurnFailureRecord(
      failureClass,
      "Disable or re-review skill-dangerous.",
      "review_skill_security",
      undefined,
      security,
    );

    expect(record).toEqual({
      failureClass: "skill_security_blocked",
      message: "Disable or re-review skill-dangerous.",
      retryable: false,
      recommendedAction: "review_skill_security",
      security: {
        scannerVersion: "1.0.0",
        skillIds: ["skill-dangerous"],
        ruleIds: ["approval_policy_bypass"],
        evidenceHashes: [evidenceHash],
      },
    });
    expect(JSON.stringify(record)).not.toContain("rawInstruction");
    expect(JSON.stringify(record)).not.toContain("bypass approval");
  });
});
