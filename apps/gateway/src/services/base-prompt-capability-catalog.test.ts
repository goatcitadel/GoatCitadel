import type { ToolAccessEvaluateRequest, ToolAccessEvaluateResponse } from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  filterBasePromptToolsetByPolicy,
  withoutUnadmittedFanout,
  withoutUnofferedCodeModeTools,
} from "./base-prompt-capability-catalog.js";

const SCOPE = { sessionId: "session-1", workspaceId: "workspace-1", mode: "chat" } as const;

function decision(toolName: string, allowed: boolean, requiresApproval = false): ToolAccessEvaluateResponse {
  return {
    toolName,
    allowed,
    requiresApproval,
    reasonCodes: allowed ? ["allowed"] : ["policy_deny"],
    riskLevel: "safe",
  } as ToolAccessEvaluateResponse;
}

describe("filterBasePromptToolsetByPolicy", () => {
  it("drops tools the turn's policy denies, so the prompt never advertises a tool the step cannot offer", async () => {
    // #494: the safe profile denies fs.write and shell.exec, the step's tool schema left them out,
    // but the prompt catalog still listed them and the model called fs_write.
    const denied = new Set(["fs.write", "shell.exec"]);
    const inspect = vi.fn(async (request: ToolAccessEvaluateRequest) =>
      decision(request.toolName, !denied.has(request.toolName), request.toolName === "fs.list"),
    );
    const filtered = await filterBasePromptToolsetByPolicy(
      { toolNames: ["fs.list", "fs.write", "documents.create", "shell.exec"], skills: [{ name: "Deep research" }] },
      SCOPE,
      inspect,
    );
    // An approval-gated tool is still callable, so it stays listed.
    expect(filtered.toolNames).toEqual(["fs.list", "documents.create"]);
    // The denied names let the prompt say what is turned off and where to change it.
    expect(filtered.policyDeniedToolNames).toEqual(["fs.write", "shell.exec"]);
    // #502: the same probe says which callable tools ask the operator first.
    expect(filtered.approvalRequiredToolNames).toEqual(["fs.list"]);
    expect(filtered.skills).toEqual([{ name: "Deep research" }]);
  });

  it("reports switched-off tools apart from denied ones", async () => {
    // A switched-off group is the operator's switch; a tools.deny entry is a policy edit. The prompt words them
    // differently, so the probe has to tell them apart by reason code. Both stay out of the callable list.
    const reasons: Record<string, string> = {
      "fs.write": "tool_group_off",
      "shell.exec": "policy_deny",
      "channel.send": "tool_group_off",
    };
    const inspect = vi.fn(async (request: ToolAccessEvaluateRequest) => {
      const reason = reasons[request.toolName];
      return reason
        ? ({
            toolName: request.toolName,
            allowed: false,
            requiresApproval: false,
            reasonCodes: [reason],
            riskLevel: "safe",
          } as ToolAccessEvaluateResponse)
        : decision(request.toolName, true);
    });
    const filtered = await filterBasePromptToolsetByPolicy(
      { toolNames: ["fs.read", "fs.write", "shell.exec", "channel.send"] },
      SCOPE,
      inspect,
    );

    expect(filtered.toolNames).toEqual(["fs.read"]);
    // Switched-off names are also denied names, so existing "what is off" wording keeps working.
    expect(filtered.policyDeniedToolNames).toEqual(["fs.write", "shell.exec", "channel.send"]);
    expect(filtered.switchedOffToolNames).toEqual(["fs.write", "channel.send"]);
  });

  it("reports no switched-off tools when nothing is switched off, or when the policy check itself fails", async () => {
    const inspect = vi.fn(async (request: ToolAccessEvaluateRequest) => {
      if (request.toolName === "fs.patch") throw new Error("policy store unavailable");
      return decision(request.toolName, request.toolName !== "fs.write");
    });
    const filtered = await filterBasePromptToolsetByPolicy(
      { toolNames: ["fs.read", "fs.write", "fs.patch"] },
      SCOPE,
      inspect,
    );

    expect(filtered.policyDeniedToolNames).toEqual(["fs.write", "fs.patch"]);
    expect(filtered.switchedOffToolNames).toEqual([]);
  });

  it("probes each tool with the runner's probe arguments and the turn's session, workspace and surface", async () => {
    const inspect = vi.fn(async (request: ToolAccessEvaluateRequest) => decision(request.toolName, true));
    await filterBasePromptToolsetByPolicy({ toolNames: ["fs.write"] }, SCOPE, inspect, "/workspace/goatcitadel_out");
    expect(inspect).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "fs.write",
        agentId: "assistant",
        sessionId: "session-1",
        workspaceId: "workspace-1",
        surface: "chat",
        args: expect.objectContaining({ path: expect.stringContaining("goatcitadel_out") }),
      }),
    );
  });

  it("treats a failed policy evaluation as not callable, like the runner does", async () => {
    const inspect = vi.fn(async (request: ToolAccessEvaluateRequest) => {
      if (request.toolName === "fs.patch") throw new Error("policy store unavailable");
      return decision(request.toolName, true);
    });
    const filtered = await filterBasePromptToolsetByPolicy({ toolNames: ["fs.read", "fs.patch"] }, SCOPE, inspect);
    expect(filtered.toolNames).toEqual(["fs.read"]);
  });
});

describe("withoutUnadmittedFanout", () => {
  it("keeps agent.fanout only on a turn whose automatic delegation was admitted (#495)", () => {
    const toolset = { toolNames: ["fs.list", "agent.fanout"], approvalRequiredToolNames: ["agent.fanout"] };
    expect(withoutUnadmittedFanout(toolset, "auto_when_useful")).toBe(toolset);
    expect(withoutUnadmittedFanout(toolset, "ask_when_useful").toolNames).toEqual(["fs.list"]);
    expect(withoutUnadmittedFanout(toolset, "off").toolNames).toEqual(["fs.list"]);
    expect(withoutUnadmittedFanout(toolset, undefined).toolNames).toEqual(["fs.list"]);
  });
});

describe("withoutUnofferedCodeModeTools", () => {
  const CODE_MODE_ONLY = ["docs.read_bytes", "docs.extract_text", "docs.decompress"];
  function toolset() {
    return {
      toolNames: ["fs.read", ...CODE_MODE_ONLY, "code_mode.request"],
      approvalRequiredToolNames: ["docs.extract_text", "code_mode.request"],
      policyDeniedToolNames: ["docs.decompress", "shell.exec"],
      switchedOffToolNames: ["docs.read_bytes"],
      skills: [{ name: "pdf" }],
    };
  }

  it("never lists the Code Mode script-only tools, which no Chat step offers", () => {
    for (const eligible of [true, false]) {
      const filtered = withoutUnofferedCodeModeTools(toolset(), eligible);
      for (const name of CODE_MODE_ONLY) {
        expect(filtered.toolNames).not.toContain(name);
        expect(filtered.approvalRequiredToolNames).not.toContain(name);
        expect(filtered.policyDeniedToolNames).not.toContain(name);
        expect(filtered.switchedOffToolNames).not.toContain(name);
      }
      expect(filtered.toolNames).toContain("fs.read");
      expect(filtered.policyDeniedToolNames).toEqual(["shell.exec"]);
      expect(filtered.skills).toEqual([{ name: "pdf" }]);
    }
  });

  it("keeps code_mode.request only on a turn the runner offers it", () => {
    const offered = withoutUnofferedCodeModeTools(toolset(), true);
    expect(offered.toolNames).toEqual(["fs.read", "code_mode.request"]);
    expect(offered.approvalRequiredToolNames).toEqual(["code_mode.request"]);

    const notOffered = withoutUnofferedCodeModeTools(toolset(), false);
    expect(notOffered.toolNames).toEqual(["fs.read"]);
    expect(notOffered.approvalRequiredToolNames).toEqual([]);
  });

  it("returns a new toolset and leaves its input alone", () => {
    const input = toolset();
    const snapshot = structuredClone(input);
    const filtered = withoutUnofferedCodeModeTools(input, false);
    expect(filtered).not.toBe(input);
    expect(input).toEqual(snapshot);
  });

  it("leaves absent name lists absent", () => {
    expect(withoutUnofferedCodeModeTools({ toolNames: ["fs.read", "docs.extract_text"] }, true)).toEqual({
      toolNames: ["fs.read"],
    });
  });
});
