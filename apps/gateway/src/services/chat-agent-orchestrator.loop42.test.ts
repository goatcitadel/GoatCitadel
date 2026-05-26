import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionResponse, ToolInvokeRequest, ToolInvokeResult } from "@goatcitadel/contracts";
import { ChatAgentOrchestrator } from "./chat-agent-orchestrator.js";
import { createMockStorage, createToolCatalog } from "./chat-agent-orchestrator-test-fixtures.js";

describe("ChatAgentOrchestrator loop42 orchestration repair coverage", () => {
  it.each([
    {
      sessionId: "sess-loop42-farmers-market",
      task: 'Cowork request: "Help me decide when to go to a farmers market this weekend without inventing exact crowd data."',
      instruction: "Use role-labeled sections in this exact order: `Researcher`, `Risk Review`, `Operator Handoff`.",
      expected: [
        "no market-specific source was retained",
        "trust the official market organizer's current hours/events page",
        "within the first 30-45 minutes after opening",
      ],
    },
    {
      sessionId: "sess-loop42-public-venue",
      task: 'Cowork request: "Shortlist a public venue for a small meetup, but do not contact or book anything."',
      instruction: "Use role-labeled sections in this exact order: `Researcher`, `Risk Review`, `Operator Handoff`.",
      expected: [
        "Meeting Room & Facility Rentals - Los Angeles Public Library",
        "Verify capacity, reservation rules",
        "do not contact anyone, submit a form, book a room, or publish details",
      ],
    },
  ])("repairs everyday cowork delegation for $sessionId", async ({ sessionId, task, instruction, expected }) => {
    const result = await runCoworkRepair({ sessionId, task, instruction });

    for (const text of expected) {
      expect(result.assistantContent).toContain(text);
    }
    expect(result.assistantContent).toContain("## Researcher");
    expect(result.assistantContent).toContain("## Risk Review");
    expect(result.assistantContent).toContain("## Operator Handoff");
  });

  it("repairs Mission Control lifecycle truth-labeling patch plans from concrete repo evidence", async () => {
    const result = await runPatchPlanRepair(
      [
        "Inspect the repo if needed and identify the exact patch points for Mission Control truth labeling.",
        "The answer must distinguish canonical lifecycle linkage from inferred fallback linkage and missing links.",
        "Concretely read `packages/contracts/src/runtime-lifecycle.ts`, `apps/gateway/src/services/runtime-lifecycle-read-service.ts`, `apps/mission-control-next/src/features/native-routes/ops/ApprovalsRoutePage.tsx`, and `apps/mission-control-next/src/features/native-routes/ops/ApprovalsRoutePage.test.tsx`.",
      ].join(" "),
    );

    expect(result.assistantContent).toContain("## API field changes");
    expect(result.assistantContent).toContain("## UI rendering changes");
    expect(result.assistantContent).toContain("## Exact label set");
    expect(result.assistantContent).toContain("`Canonical`, `Inferred`, `Missing`");
    expect(result.assistantContent).toContain("## UI regression check");
    expect(result.assistantContent).toContain(
      "apps/mission-control-next/src/features/native-routes/ops/ApprovalsRoutePage.test.tsx",
    );
    expect(result.assistantContent).not.toContain("generic patch");
  });

  it("repairs explicit event-authority envelope patch plans from concrete repo evidence", async () => {
    const result = await runPatchPlanRepair(
      [
        "Inspect the repo if needed and identify the exact patch points for an explicit event authority envelope patch plan.",
        "The answer must cover eventClass, eventAuthority, links, producer propagation, storage round-trip, and consumer contract.",
        "Concretely read `apps/gateway/src/services/tool-invocation-coordinator-service.ts`, `packages/storage/src/realtime-event-repo.ts`, `apps/gateway/src/routes/events.ts`, and `packages/mission-control-shared/src/api/types.ts`.",
      ].join(" "),
    );

    expect(result.assistantContent).toContain("## Producer contract");
    expect(result.assistantContent).toContain("## Storage contract");
    expect(result.assistantContent).toContain("## Consumer contract");
    expect(result.assistantContent).toContain("## Event families");
    expect(result.assistantContent).toContain("## Propagation test to add");
    expect(result.assistantContent).toContain("eventClass`, `eventAuthority`, and `links");
    expect(result.assistantContent).not.toContain("generic patch");
  });
});

async function runCoworkRepair(input: {
  sessionId: string;
  task: string;
  instruction: string;
}): Promise<{ assistantContent: string }> {
  const wrappedPrompt = [
    "## Prompt Lab Run Contract",
    "- Mode: cowork",
    "- Tool tier: no-tools",
    "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
    "",
    "## User Task",
    input.task,
    "",
    input.instruction,
  ].join("\n");
  const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
    model: "gpt-5.5",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "I can give a brief plan, but the requested roles and provenance are not expanded yet.",
        },
      },
    ],
  });
  const orchestrator = new ChatAgentOrchestrator({
    storage: createMockStorage() as never,
    listToolCatalog: () => createToolCatalog([]),
    createChatCompletion,
    invokeTool: vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>(),
  });

  return orchestrator.run({
    sessionId: input.sessionId,
    turnId: randomUUID(),
    userMessageId: `${input.sessionId}-message`,
    content: wrappedPrompt,
    mode: "cowork",
    providerId: "openai-codex",
    model: "gpt-5.5",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "extended",
    toolAutonomy: "manual",
    normalizationProfile: "prompt_pack_harness",
    historyMessages: [{ role: "user", content: wrappedPrompt }],
  });
}

async function runPatchPlanRepair(task: string): Promise<{ assistantContent: string }> {
  const wrappedPrompt = [
    "## Prompt Lab Run Contract",
    "- Mode: code",
    "- Tool tier: implicit-tools",
    "- This is a repo-grounded code evaluation. Inspect the repository before answering whenever current repo state matters.",
    "- Repo inspection assist: enabled.",
    "- Required tool families: file/code tools",
    "",
    "## User Task",
    task,
    "",
    "Answer contract:",
    "- Cite the exact files whose contents you concretely read.",
    "- Keep the patch plan grouped by exact patch area.",
    "- Include a validation or regression-test step.",
  ].join("\n");
  const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
    model: "gpt-5.4",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "A generic patch should update runtime labels and tests. Parts of this answer may be incomplete.",
        },
      },
    ],
  });
  const orchestrator = new ChatAgentOrchestrator({
    storage: createMockStorage() as never,
    listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
    createChatCompletion,
    invokeTool: createMissionControlTruthEvidenceTool(),
  });

  return orchestrator.run({
    sessionId: `sess-loop42-truth-labels-${randomUUID()}`,
    turnId: randomUUID(),
    userMessageId: `msg-loop42-truth-labels-${randomUUID()}`,
    content: wrappedPrompt,
    mode: "code",
    providerId: "openai",
    model: "gpt-5.4",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "extended",
    toolAutonomy: "safe_auto",
    normalizationProfile: "prompt_pack_harness",
    historyMessages: [{ role: "user", content: wrappedPrompt }],
  });
}

function createMissionControlTruthEvidenceTool(): (request: ToolInvokeRequest) => Promise<ToolInvokeResult> {
  return vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>(async (request) => {
    if (request.toolName === "code.search_files") {
      return {
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: `audit-loop42-search-${String(request.args.query ?? "query").replace(/[^a-z0-9]+/gi, "-")}`,
        result: {
          matches: Object.keys(TRUTH_LABELING_EVIDENCE_BY_PATH).map((path) => ({
            path,
            name: path.split("/").at(-1),
            type: "file",
          })),
        },
      };
    }
    const path = String(request.args.path ?? "");
    return {
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: `audit-loop42-read-${path.replace(/[^a-z0-9]+/gi, "-")}`,
      result: {
        path,
        startLine: 1,
        endLine: 160,
        content: TRUTH_LABELING_EVIDENCE_BY_PATH[path] ?? `// ${path}\nexport const placeholder = true;`,
      },
    };
  });
}

const TRUTH_LABELING_EVIDENCE_BY_PATH: Record<string, string> = {
  "packages/contracts/src/runtime-lifecycle.ts": [
    "export type RuntimeLifecycleFieldSource = 'approval_linkage' | 'fallback_payload' | 'fallback_preview' | 'realtime_links';",
    "export interface RuntimeLifecycleResolution {",
    "  canonicalApprovalLinkageUsed: boolean;",
    "  realtimeLinkageUsed: boolean;",
    "  payloadFallbackUsed: boolean;",
    "  fallbackSources: RuntimeLifecycleFieldSource[];",
    "}",
  ].join("\n"),
  "apps/gateway/src/services/runtime-lifecycle-read-service.ts": [
    "export class RuntimeLifecycleReadService {",
    "  getRuntimeLifecycle(input) {",
    "    return this.applyApprovalCanonical(input.approvalId) ?? this.applyFallbacks(input);",
    "  }",
    "  private applyApprovalCanonical(approvalId) { return approvalId ? { source: 'approval_linkage' } : undefined; }",
    "  private applyFallbacks(input) { return { source: 'fallback_preview', fallbackSources: ['fallback_preview'] }; }",
    "}",
  ].join("\n"),
  "apps/mission-control-next/src/features/native-routes/ops/ApprovalsRoutePage.tsx": [
    "import { fetchRuntimeLifecycle } from '../api/client';",
    "export function ApprovalsRoutePage() {",
    "  const lifecycle = fetchRuntimeLifecycle({ approvalId: selectedApproval.id });",
    "  return <LifecyclePanel lifecycle={lifecycle} />;",
    "}",
  ].join("\n"),
  "apps/mission-control-next/src/features/native-routes/ops/ApprovalsRoutePage.test.tsx": [
    "import { render, screen } from '@testing-library/react';",
    "describe('ApprovalsRoutePage', () => {",
    "  it('renders lifecycle linkage metadata from fetchRuntimeLifecycle', async () => {});",
    "});",
  ].join("\n"),
  "apps/gateway/src/services/tool-invocation-coordinator-service.ts": [
    "export class ToolInvocationCoordinatorService {",
    "  publishToolEvent(input) {",
    "    return this.events.append({ eventClass: 'tool.invocation', eventAuthority: 'retained', links: input.links });",
    "  }",
    "}",
  ].join("\n"),
  "packages/storage/src/realtime-event-repo.ts": [
    "export class RealtimeEventRepository {",
    "  append(input) { return { eventClass: input.eventClass, eventAuthority: input.eventAuthority, links: input.links }; }",
    "  list() { return [{ eventClass: 'tool.invocation', eventAuthority: 'retained', links: { runId: 'run-1' } }]; }",
    "}",
  ].join("\n"),
  "apps/gateway/src/routes/events.ts":
    "export async function eventsRoutes(app) { app.get('/api/v1/events', async () => realtimeEvents.list()); }",
  "packages/mission-control-shared/src/api/types.ts": [
    "export interface RealtimeEventDto {",
    "  eventClass: string;",
    "  eventAuthority: 'retained' | 'durable_history' | 'derived_projection';",
    "  links?: Record<string, string>;",
    "}",
  ].join("\n"),
};
