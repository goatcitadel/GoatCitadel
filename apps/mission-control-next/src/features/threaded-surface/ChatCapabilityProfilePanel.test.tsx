import React from "react";
import { readFileSync } from "node:fs";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type {
  ChatRoutedContextInspection,
  ChatTurnCapabilityProfilePreview,
  ChatTurnCapabilityProfileRecord,
} from "@goatcitadel/contracts";
import type { ChatCapabilityProfileInspection } from "@goatcitadel/threaded-surface-core";
import { describe, expect, it } from "vitest";
import { ChatCapabilityProfilePreflight, ChatCapabilityProfileRunDetail } from "./ChatCapabilityProfilePanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HASH = "a".repeat(64);

function preview(): ChatTurnCapabilityProfilePreview {
  return {
    schemaVersion: "chat.turn.capability-profile.v1",
    fingerprint: "f".repeat(64),
    contentHash: "c".repeat(64),
    providerId: "openai",
    model: "gpt-5",
    fallbackCount: 0,
    selectedTools: [{ canonicalName: "web.search", modelName: "web_search", requiresApproval: true }],
    trustedSkills: [{ skillId: "repo-review", trustLabel: "Reviewed" }],
    memory: {
      mode: "auto",
      retrievalMode: "standard",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      contextManifestRef: `chat-memory-scope:${HASH}`,
      writeApprovalRequired: true,
    },
    approval: {
      mode: "approve_risky",
      selectedToolCount: 1,
      toolsRequiringApproval: ["web.search"],
      approvalGranted: false,
    },
    authReadiness: [{ kind: "provider", ref: "openai", status: "ready", reasonCodes: [] }],
    blockedReasons: [],
  };
}

function persistedProfile(): ChatTurnCapabilityProfileRecord {
  return {
    profileId: "profile-1",
    schemaVersion: "chat.turn.capability-profile.v1",
    identity: { turnId: "turn-1", sessionId: "session-1", workspaceId: "workspace-1", citadelId: "citadel-1" },
    source: { channel: "chat", account: "operator" },
    catalog: {
      snapshotId: "snapshot-1",
      inspectableHash: HASH,
      callableHash: "b".repeat(64),
      inspectableCount: 2,
      callableCount: 2,
    },
    selection: {
      contentHash: "c".repeat(64),
      effectiveProviderId: "openai",
      effectiveModel: "gpt-5",
      allowedFallbacks: [],
      mode: "chat",
      webMode: "auto",
      memory: {
        mode: "auto",
        retrievalMode: "standard",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        contextManifestRef: `chat-memory-scope:${HASH}`,
        writeApprovalRequired: true,
      },
      thinkingLevel: "standard",
      speedMode: "standard",
      subagentPolicy: "ask_when_useful",
      toolAutonomy: "manual",
      tools: [
        {
          canonicalName: "web.search",
          modelName: "web_search",
          definitionHash: "d".repeat(64),
          providerDefinition: { type: "function", function: { name: "web_search", parameters: { type: "object" } } },
        },
      ],
      modelNameAllowMap: [{ modelName: "web_search", canonicalName: "web.search" }],
      trustedSkills: [
        {
          capabilityId: "skill:repo-review",
          skillId: "repo-review",
          category: "optional",
          lifecycleState: "trusted",
          trustLabel: "Reviewed",
          source: "git",
          commitSha: "1234567890abcdef",
          contentIntegrityManifestVersion: "goatcitadel.skill-tree.v1",
          treeSha256: "e".repeat(64),
          contentFileCount: 2,
          contentBytes: 512,
        },
      ],
    },
    governance: {
      activeGrants: [],
      permission: { profileId: "safe", approvalMode: "approve_risky", profileHash: "9".repeat(64) },
      policyDecisions: [
        {
          toolName: "web.search",
          allowed: true,
          requiresApproval: true,
          reasonCodes: ["approval_required"],
        },
      ],
      authReadiness: [
        { kind: "provider", ref: "openai", status: "ready", reasonCodes: [] },
        { kind: "tool", ref: "web.search", status: "unknown", reasonCodes: ["runtime_auth_check_required"] },
      ],
      approval: {
        mode: "approve_risky",
        selectedToolCount: 1,
        toolsRequiringApproval: ["web.search"],
        approvalGranted: false,
      },
    },
    hashes: {
      identityHash: "1".repeat(64),
      sourceHash: "2".repeat(64),
      catalogHash: "3".repeat(64),
      selectionHash: "4".repeat(64),
      governanceHash: "5".repeat(64),
      profileHash: HASH,
    },
    preflightFingerprint: "f".repeat(64),
    createdAt: "2026-07-13T00:00:00.000Z",
  };
}

function routedContextReceipt(): ChatRoutedContextInspection {
  return {
    snapshotId: "snapshot-1",
    snapshotHash: "a".repeat(64),
    sourceRequestHash: "b".repeat(64),
    contentHash: "c".repeat(64),
    includedCount: 1,
    truncatedCount: 0,
    omittedCount: 0,
    alreadyAttachedCount: 1,
    budget: {
      effectiveProviderId: "openai",
      effectiveModel: "gpt-5",
      contextWindowTokens: 16_384,
      promptReservedTokens: 1_024,
      outputReservedTokens: 2_048,
      hardCapTokens: 4_096,
      effectiveBudgetTokens: 4_096,
      usedTokens: 32,
      usedBytes: 100,
      estimatorVersion: "gc-approx-tokens.v1",
      budgetPolicyVersion: "chat.routed-context-budget.v1",
    },
    entries: [
      {
        index: 0,
        kind: "memory_item",
        ref: "private-memory-id",
        label: "C:\\private\\notes.txt",
        disposition: "included",
        sourceScope: "workspace",
        sourceWorkspaceId: "workspace-1",
        sourceVersion: "2026-07-13T00:00:00.000Z",
        sourceHash: "d".repeat(64),
        originalBytes: 100,
        admittedBytes: 100,
        admittedTokens: 32,
      },
    ],
  };
}

function render(node: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(node);
  });
  return renderer;
}

function renderedText(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

describe("ChatCapabilityProfilePanel", () => {
  it("shows a compact preflight chip with progressively disclosed exact selections", () => {
    const renderer = render(<ChatCapabilityProfilePreflight profile={preview()} />);
    const text = renderedText(renderer);

    expect(text).toContain("Capabilities ready");
    expect(text).toContain("tools ·");
    expect(text).toContain("Inspect proposed profile");
    expect(text).toContain("web.search");
    expect(text).toContain("Fallbacks");
    expect(renderer.root.findAllByType("details")).toHaveLength(1);
    expect(renderer.root.findAllByType("table")).toHaveLength(0);
    expect(renderer.root.findAllByType("pre")).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it("renders persisted detail only after exact hash and selection verification", () => {
    const inspection: ChatCapabilityProfileInspection = {
      status: "verified",
      profile: persistedProfile(),
      expectedProfileId: "profile-1",
      expectedProfileHash: HASH,
      mismatchFields: [],
      routedContext: routedContextReceipt(),
      message: "Profile hash, identity, route, and execution selections match the selected turn.",
    };
    const renderer = render(<ChatCapabilityProfileRunDetail inspection={inspection} />);
    const text = renderedText(renderer);

    expect(text).toContain("Exact profile match");
    expect(text).toContain(HASH);
    expect(text).toContain("openai / gpt-5");
    expect(text).toContain("Fallback frozen off");
    expect(text).toContain("definition dddddddddddd");
    expect(text).toContain("Routed context");
    expect(text).toContain('"1"," included"');
    expect(text).toContain('"1"," already attached"');
    expect(text).toContain('"32"," / ","4096"," tokens"');
    expect(text).toContain('"Source ","1"," · ","memory item"');
    expect(text).not.toContain("private-memory-id");
    expect(text).not.toContain("C:\\\\private");
    expect(text).not.toContain("providerDefinition");
    expect(renderer.root.findByProps({ "data-integrity-status": "verified" })).toBeTruthy();
    act(() => renderer.unmount());
  });

  it("keeps profile content hidden for scoped access failures and integrity mismatches", () => {
    for (const inspection of [
      {
        status: "forbidden",
        profile: null,
        mismatchFields: [],
        message: "This capability profile is outside the current operator or workspace scope.",
      },
      {
        status: "invalid",
        profile: null,
        mismatchFields: ["profile hash", "effective model"],
        message: "The persisted profile does not exactly match the selected turn trace.",
      },
    ] satisfies ChatCapabilityProfileInspection[]) {
      const renderer = render(<ChatCapabilityProfileRunDetail inspection={inspection} />);
      const text = renderedText(renderer);
      expect(text).not.toContain(HASH);
      expect(text).not.toContain("web.search");
      expect(renderer.root.findAllByProps({ "data-profile-id": "profile-1" })).toHaveLength(0);
      act(() => renderer.unmount());
    }
  });

  it("has a narrow-screen single-column proof for facts and selection cards", () => {
    const css = readFileSync(new URL("./styles/capability-profile.css", import.meta.url), "utf8");
    const mobile = css.slice(css.indexOf("@media (width < 720px)"));

    expect(mobile).toContain(".mc-next-capability-profile-facts");
    expect(mobile).toContain(".mc-next-capability-profile-columns");
    expect(mobile).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(css).toContain("word-break: break-all");
  });
});
