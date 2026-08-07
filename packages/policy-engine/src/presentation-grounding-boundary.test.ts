import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stablePresentationSourceId } from "./presentation-model.js";
import { executeArtifactTool } from "./tool-executor/artifact-executor.js";

const createdRoots: string[] = [];

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("governed research presentation grounding boundary", () => {
  it("rejects forged structured sources without a server grounding receipt before visuals or output", async () => {
    const root = createRoot();
    const deckPath = path.join(root, "forged-no-receipt.pptx");
    const args = researchPresentationArgs(deckPath, "https://forged.invalid/market-report");
    const request = toolRequest(args);
    const preparePresentationVisuals = vi.fn();

    await expect(
      executeArtifactTool("presentations.create", args, policyConfig(root), {
        request,
        preparePresentationVisuals,
      }),
    ).rejects.toThrow("require a valid server-authored presentationGrounding receipt");

    expect(preparePresentationVisuals).not.toHaveBeenCalled();
    expect(fs.existsSync(deckPath)).toBe(false);
  });

  it("admits a structured research deck with a valid server grounding receipt", async () => {
    const root = createRoot();
    const deckPath = path.join(root, "grounded-research.pptx");
    const args = researchPresentationArgs(deckPath, "https://example.com/market-report");
    const request = toolRequest(args);
    request.presentationGrounding = {
      sourceTermCount: 1,
      matchedSourceTermCount: 1,
      sourceUrlCount: 1,
      matchedSourceUrlCount: 1,
    };
    const preparePresentationVisuals = vi.fn(async () => ({
      plan: [],
      assets: [],
      warnings: [],
      providerCalls: 0,
    }));

    const result = await executeArtifactTool("presentations.create", args, policyConfig(root), {
      request,
      preparePresentationVisuals,
    });

    expect(preparePresentationVisuals).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(deckPath)).toBe(true);
    expect(result).toMatchObject({
      research: { sourceCount: 1 },
      packageAudit: { passed: true },
      visualProviderCalls: 0,
    });
  }, 20_000);

  it("rejects model-callable presenter notes before visuals or output even with a valid receipt", async () => {
    const root = createRoot();
    const deckPath = path.join(root, "untrusted-notes.pptx");
    const args = researchPresentationArgs(deckPath, "https://example.com/market-report");
    (args.slides as Array<Record<string, unknown>>)[0]!.speakerNotes = "A model-authored note.";
    const request = toolRequest(args);
    request.presentationGrounding = validGroundingReceipt();
    const preparePresentationVisuals = vi.fn();

    await expect(
      executeArtifactTool("presentations.create", args, policyConfig(root), {
        request,
        preparePresentationVisuals,
      }),
    ).rejects.toThrow("does not accept model-authored speakerNotes");

    expect(preparePresentationVisuals).not.toHaveBeenCalled();
    expect(fs.existsSync(deckPath)).toBe(false);
  });

  it("rejects internal or placeholder visible input without deleting or replacing it", async () => {
    const root = createRoot();
    const deckPath = path.join(root, "placeholder-input.pptx");
    const args = researchPresentationArgs(deckPath, "https://example.com/market-report");
    (args.slides as Array<Record<string, unknown>>)[0]!.title = "TODO_PLACEHOLDER";
    const request = toolRequest(args);
    request.presentationGrounding = validGroundingReceipt();
    const preparePresentationVisuals = vi.fn();

    await expect(
      executeArtifactTool("presentations.create", args, policyConfig(root), {
        request,
        preparePresentationVisuals,
      }),
    ).rejects.toThrow("contains internal or placeholder metadata");

    expect(preparePresentationVisuals).not.toHaveBeenCalled();
    expect(fs.existsSync(deckPath)).toBe(false);
  });
});

function createRoot(): string {
  const root = path.join(os.tmpdir(), `goatcitadel-presentation-grounding-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  createdRoots.push(root);
  return root;
}

function policyConfig(root: string): ToolPolicyConfig {
  return {
    profiles: { danger: ["*"] },
    tools: { profile: "danger", allow: [], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: [root],
      readOnlyRoots: [root],
      networkAllowlist: [],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
}

function toolRequest(args: Record<string, unknown>): ToolInvokeRequest {
  return {
    toolName: "presentations.create",
    args,
    agentId: "presentation-test-agent",
    sessionId: "presentation-test-session",
  };
}

function validGroundingReceipt(): NonNullable<ToolInvokeRequest["presentationGrounding"]> {
  return {
    sourceTermCount: 1,
    matchedSourceTermCount: 1,
    sourceUrlCount: 1,
    matchedSourceUrlCount: 1,
  };
}

function researchPresentationArgs(deckPath: string, sourceUrl: string): Record<string, unknown> {
  const sourceId = stablePresentationSourceId(sourceUrl);
  return {
    path: deckPath,
    title: "Governed Research Deck",
    subtitle: "Evidence current through 2026-08-07",
    research: {
      asOfDate: "2026-08-07",
      geography: "North America",
      physicalDigitalBoundary: "Physical products are primary; digital products are adjacent.",
      inclusionCriteria: ["Active retail distribution"],
      exclusions: ["Inactive products"],
      methodology: ["Official and independent source review"],
      limitations: ["Public evidence only"],
      competitors: ["Example"],
      comparisonCriteria: ["Player fit"],
    },
    sources: [
      {
        id: sourceId,
        title: "Claimed official market report",
        url: sourceUrl,
        publisher: "Example Publisher",
        role: "official",
        publicationDate: "2026-08-01",
      },
    ],
    slides: [
      {
        title: "Finding",
        bullets: [{ text: "The product remains active.", claimKind: "fact", sourceIds: [sourceId] }],
      },
    ],
  };
}
