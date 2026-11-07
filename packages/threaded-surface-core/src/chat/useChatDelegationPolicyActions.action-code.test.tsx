import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Task 3 delegation execution boundary", () => {
  it("keeps remote execution imports out of the mounted owner", () => {
    const owner = readFileSync(new URL("./useChatDelegationPolicyActions.ts", import.meta.url), "utf8");
    const staticImports = [...owner.matchAll(/import\s+(?!type\b)[\s\S]*?from\s+["'][^"']+["'];/g)]
      .map(match => match[0]).join("\n");
    expect(staticImports).not.toMatch(/\b(?:runChatDelegation|runChatResearch|streamChatDelegation|suggestChatDelegation|triggerChatProactive|updateChatProactivePolicy)\b/);
    expect(owner).toMatch(/import\(["']\.\/delegation-action-code["']\)/);
    // Canonical hydration stays mounted; an execution import is never its prerequisite.
    expect(staticImports).toContain("fetchChatDelegationRun");
    expect(staticImports).toContain("fetchLatestChatWorkspaceExplorer");
  });
});
