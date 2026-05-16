import { describe, expect, it } from "vitest";
import {
  applyShellExplainerPolicy,
  explainCommandsForApproval,
  extractApprovalCommands,
} from "./shell-command-explainer.js";

describe("explainCommandsForApproval", () => {
  it("returns explanations matching the shared parser", () => {
    const out = explainCommandsForApproval(["git push --force origin main", "pnpm install"]);
    expect(out).toHaveLength(2);
    expect(out[0].highestRisk).toBe("danger");
    expect(out[1].highestRisk).toBe("info");
  });

  it("returns empty array for empty input", () => {
    expect(explainCommandsForApproval([])).toEqual([]);
  });

  it("preserves command order", () => {
    const out = explainCommandsForApproval(["pnpm install", "rm -rf /tmp/x"]);
    expect(out[0].command).toBe("pnpm install");
    expect(out[1].command).toBe("rm -rf /tmp/x");
  });
});

describe("extractApprovalCommands", () => {
  it("extracts commands array from preview", () => {
    const out = extractApprovalCommands({
      preview: { commands: ["git push", "rm -rf /tmp/x"] },
      payload: {},
    });
    expect(out).toEqual(["git push", "rm -rf /tmp/x"]);
  });

  it("extracts singular command field", () => {
    const out = extractApprovalCommands({
      preview: { command: "git status" },
      payload: {},
    });
    expect(out).toEqual(["git status"]);
  });

  it("deduplicates same command appearing in preview and payload", () => {
    const out = extractApprovalCommands({
      preview: { command: "git status" },
      payload: { command: "git status" },
    });
    expect(out).toEqual(["git status"]);
  });

  it("returns empty array when no command fields present", () => {
    expect(extractApprovalCommands({ preview: {}, payload: {} })).toEqual([]);
  });
});

describe("backfillMissingShellExplanations", () => {
  function fakeStorage(
    approvals: Array<{
      approvalId: string;
      preview: Record<string, unknown>;
      payload: Record<string, unknown>;
      shellExplanations?: unknown[];
    }>,
  ) {
    const stored = new Map(approvals.map((a) => [a.approvalId, a]));
    return {
      approvals: {
        list: () => approvals.map((a) => ({ ...a, status: "pending" as const })),
        setShellExplanations: (id: string, explanations: unknown[]) => {
          const a = stored.get(id);
          if (!a) return false;
          a.shellExplanations = explanations;
          return true;
        },
      },
    } as never;
  }

  it("backfills approvals missing shellExplanations", async () => {
    const { backfillMissingShellExplanations } = await import("./shell-command-explainer.js");
    const storage = fakeStorage([
      {
        approvalId: "a1",
        preview: { commands: ["rm -rf /tmp/x"] },
        payload: { commands: ["rm -rf /tmp/x"] },
      },
      {
        approvalId: "a2",
        preview: { commands: ["pnpm install"] },
        payload: { commands: ["pnpm install"] },
        shellExplanations: [
          { command: "pnpm install", parsed: true, summary: "x", details: [], risks: [], highestRisk: "info" },
        ],
      },
    ]);
    const result = backfillMissingShellExplanations(storage);
    expect(result.scanned).toBe(2);
    expect(result.backfilled).toBe(1);
  });

  it("skips approvals with no commands", async () => {
    const { backfillMissingShellExplanations } = await import("./shell-command-explainer.js");
    const storage = fakeStorage([{ approvalId: "a1", preview: {}, payload: {} }]);
    expect(backfillMissingShellExplanations(storage).backfilled).toBe(0);
  });
});

describe("applyShellExplainerPolicy", () => {
  const policyOn = { enabled: true, elevateOnDanger: "danger" as const, autoRejectOnDanger: false };
  const policyOff = { enabled: false };

  it("elevates riskLevel from safe to danger when policy is on and a danger command is found", () => {
    const out = applyShellExplainerPolicy(
      {
        riskLevel: "safe",
        payload: { commands: ["rm -rf /tmp/x"] },
        preview: { commands: ["rm -rf /tmp/x"] },
      },
      policyOn,
    );
    expect(out.explanations).toHaveLength(1);
    expect(out.elevatedRiskLevel).toBe("danger");
    expect(out.autoReject).toBe(false);
  });

  it("does NOT elevate when policy is off", () => {
    const out = applyShellExplainerPolicy(
      {
        riskLevel: "safe",
        payload: { commands: ["rm -rf /tmp/x"] },
        preview: { commands: ["rm -rf /tmp/x"] },
      },
      policyOff,
    );
    expect(out.elevatedRiskLevel).toBeUndefined();
  });

  it("does NOT elevate when no commands are present", () => {
    const out = applyShellExplainerPolicy({ riskLevel: "safe", payload: {}, preview: {} }, policyOn);
    expect(out.explanations).toEqual([]);
    expect(out.elevatedRiskLevel).toBeUndefined();
  });

  it("does NOT elevate below current risk level", () => {
    const out = applyShellExplainerPolicy(
      {
        riskLevel: "nuclear",
        payload: { commands: ["rm -rf /tmp/x"] },
        preview: { commands: ["rm -rf /tmp/x"] },
      },
      policyOn,
    );
    expect(out.elevatedRiskLevel).toBeUndefined();
  });

  it("sets autoReject and reason when configured", () => {
    const out = applyShellExplainerPolicy(
      {
        riskLevel: "caution",
        payload: { commands: ["rm -rf /tmp/x"] },
        preview: { commands: ["rm -rf /tmp/x"] },
      },
      { enabled: true, elevateOnDanger: "danger", autoRejectOnDanger: true },
    );
    expect(out.autoReject).toBe(true);
    expect(out.autoRejectReason).toMatch(/rm -rf \/tmp\/x/);
  });
});
