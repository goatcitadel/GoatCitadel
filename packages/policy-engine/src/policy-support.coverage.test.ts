import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PendingApprovalAction, ToolInvokeRequest } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasVerifiedApprovalBypass } from "./approval-bypass.js";
import { stripHtmlNoiseTags, stripHtmlTags } from "./html-noise.js";
import { assertExistingPathRealpathAllowed, assertWritePathInJail } from "./sandbox/path-jail.js";
import { matchesToolPattern } from "./tool-patterns.js";
import { buildInternalToolCall, collectLeakDetections, deriveToolCapabilityPolicy } from "./tool-security.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("tool pattern support", () => {
  it("rejects blank patterns before matching", () => {
    expect(matchesToolPattern("   ", "fs.read")).toBe(false);
  });
});

describe("approval bypass support", () => {
  it("matches pending approval args with stable object keys and nested arrays", () => {
    const request = createToolInvokeRequest({
      args: {
        alpha: "first",
        nested: [
          {
            zed: true,
            able: 1,
          },
        ],
      },
    });
    const storage = createStorageWithPendingApproval({
      request: {
        ...request,
        args: {
          nested: [
            {
              able: 1,
              zed: true,
            },
          ],
          alpha: "first",
        },
      },
    });

    expect(hasVerifiedApprovalBypass(request, storage)).toBe(true);
  });

  it("rejects no-expiry pending approvals with malformed creation dates", () => {
    const request = createToolInvokeRequest();
    const storage = createStorageWithPendingApproval({
      createdAt: "not-a-date",
      request: request as unknown as Record<string, unknown>,
    });

    expect(hasVerifiedApprovalBypass(request, storage)).toBe(false);
  });
});

describe("HTML noise stripping", () => {
  it("returns early for empty input or no configured noise tags", () => {
    expect(stripHtmlNoiseTags("", ["script"])).toBe("");
    expect(stripHtmlNoiseTags("plain", [])).toBe("plain");
    expect(stripHtmlTags("")).toBe("");
  });

  it("handles malformed and boundary-sensitive noise tags", () => {
    expect(stripHtmlNoiseTags("before<script", ["script"])).toBe("before ");
    expect(stripHtmlNoiseTags("before<script>evil after", ["script"])).toBe("before evil after");
    expect(stripHtmlNoiseTags("<scriptx>keep</scriptx>", ["script"])).toBe("<scriptx>keep</scriptx>");
    expect(stripHtmlNoiseTags("a<script>x</scripted>still hidden</script>b", ["script"])).toBe("a b");
  });

  it("keeps malformed normal tags and honors quoted close characters", () => {
    expect(stripHtmlTags("before <broken")).toBe("before <broken");
    expect(stripHtmlTags('before<a title="1>2">link</a>after')).toBe("before link after");
  });
});

describe("path jail support", () => {
  it("checks existing realpaths against write and readonly roots", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-realpath-"));
    tempDirs.push(root);
    const readonlyRoot = path.join(root, "readonly");
    fs.mkdirSync(readonlyRoot);
    const filePath = path.join(readonlyRoot, "note.txt");
    fs.writeFileSync(filePath, "ok", "utf8");

    expect(() => assertExistingPathRealpathAllowed(filePath, [], [readonlyRoot])).not.toThrow();
    expect(() => assertExistingPathRealpathAllowed(filePath, [path.join(root, "other")], [])).toThrow(
      /outside read allowlist/i,
    );
  });

  it("falls back to lexical jail validation when no path ancestor exists", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    expect(() =>
      assertWritePathInJail(path.resolve("virtual-jail", "missing", "proof.txt"), [path.resolve("virtual-jail")]),
    ).not.toThrow();
  });
});

describe("tool security support", () => {
  it("copies source attribution and defaults communication tools to the tool-host boundary", () => {
    const request = createToolInvokeRequest({
      toolName: "gmail.send",
      args: {
        body: "token sk-123456789012345678901234",
      },
      sourceAttribution: [
        {
          sourceType: "file",
          sourceRef: "drive:doc-1",
          title: "Plan",
          backend: "native",
        },
      ],
    });

    const call = buildInternalToolCall(
      request,
      deriveToolCapabilityPolicy(request.toolName),
      "2026-03-22T12:00:00.000Z",
    );

    expect(call.authContext.boundary).toBe("tool_host_boundary");
    expect(call.sourceAttribution).toEqual([
      {
        sourceType: "file",
        sourceRef: "drive:doc-1",
        title: "Plan",
        backend: "native",
      },
    ]);
    expect(call.args).toEqual({
      body: "token [REDACTED]",
    });
  });

  it("collects leak detections from strings and handles non-serializable inputs", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(collectLeakDetections("Bearer abcdefghijklmnopqrstuvwxyz")).toEqual(["bearer_token"]);
    expect(collectLeakDetections(circular)).toEqual([]);
  });
});

function createToolInvokeRequest(overrides: Partial<ToolInvokeRequest> = {}): ToolInvokeRequest {
  return {
    toolName: "fs.write",
    args: {
      path: "notes.md",
    },
    agentId: "agent-1",
    sessionId: "session-1",
    taskId: "task-1",
    workspaceId: "workspace-1",
    consentContext: {
      reason: "approval:approval-1",
    },
    ...overrides,
  } as ToolInvokeRequest;
}

function createStorageWithPendingApproval(overrides: Partial<PendingApprovalAction> = {}): Storage {
  const pending: PendingApprovalAction = {
    approvalId: "approval-1",
    actionType: "tool.invoke",
    request: createToolInvokeRequest() as unknown as Record<string, unknown>,
    createdAt: new Date(Date.now() - 1_000).toISOString(),
    resolutionStatus: "pending",
    ...overrides,
  };

  return {
    pendingApprovalActions: {
      find: vi.fn(() => pending),
    },
  } as unknown as Storage;
}
