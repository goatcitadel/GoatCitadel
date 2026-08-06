import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ApprovalRequest, PendingApprovalAction, ToolInvokeRequest } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasVerifiedApprovalBypass } from "./approval-bypass.js";
import { stripHtmlNoiseTags, stripHtmlTags } from "./html-noise.js";
import { assertExistingPathRealpathAllowed, assertWritePathInJail } from "./sandbox/path-jail.js";
import { matchesToolPattern } from "./tool-patterns.js";
import {
  buildInternalToolCall,
  buildToolAuditRecord,
  collectLeakDetections,
  deriveToolCapabilityPolicy,
  resolveToolTrustLevel,
  sanitizeForAudit,
  sanitizeForModel,
} from "./tool-security.js";

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

  it("normalizes tool names before exact and wildcard matching", () => {
    expect(matchesToolPattern("fs.read", " fs.read ")).toBe(true);
    expect(matchesToolPattern("browser.*", " browser.navigate ")).toBe(true);
  });

  it("rejects blank or pathological pattern inputs", () => {
    expect(matchesToolPattern("*", "   ")).toBe(false);
    expect(matchesToolPattern(`${"a".repeat(513)}*`, "fs.read")).toBe(false);
    expect(matchesToolPattern("fs.*", `${"a".repeat(513)}`)).toBe(false);
  });
});

describe("approval bypass support", () => {
  it("matches pending approval args with stable object keys and nested arrays", async () => {
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

    expect(await hasVerifiedApprovalBypass(request, storage)).toBe(true);
  });

  it("matches pending approvals by effective trust across source attribution and top-level trust", async () => {
    const sourceAttribution = [
      {
        sourceType: "url",
        sourceRef: "https://example.com/prompt",
        trustLevel: "untrusted_external",
      },
    ] satisfies ToolInvokeRequest["sourceAttribution"];
    const storedRequest = createToolInvokeRequest({ sourceAttribution });
    const request = createToolInvokeRequest({
      trustLevel: "untrusted_external",
      sourceAttribution,
    });
    const storage = createStorageWithPendingApproval({
      request: storedRequest as unknown as Record<string, unknown>,
    });

    expect(await hasVerifiedApprovalBypass(request, storage)).toBe(true);
  });

  it("binds governed skill, path-repair, and grounding receipts to the approved request", async () => {
    const storedRequest = createToolInvokeRequest({
      turnId: "turn-1",
      runtimeSkillApplications: [
        {
          skillId: "bundled:design-intelligence",
          treeSha256: "1".repeat(64),
          instructionSha256: "2".repeat(64),
          modules: ["main", "layout"],
        },
      ],
      writePathRepair: {
        originalPath: "/workspace/deck.pptx",
        repairedPath: "workspace/deck.pptx",
        originalReasonCodes: ["structural_safety_block"],
        repairedReasonCodes: ["approval_required"],
      },
      presentationGrounding: { sourceTermCount: 8, matchedSourceTermCount: 6 },
    });
    const storage = createStorageWithPendingApproval({
      request: storedRequest as unknown as Record<string, unknown>,
    });

    expect(await hasVerifiedApprovalBypass(storedRequest, storage)).toBe(true);
    expect(await hasVerifiedApprovalBypass({ ...storedRequest, runtimeSkillApplications: [] }, storage)).toBe(false);
    expect(
      await hasVerifiedApprovalBypass(
        { ...storedRequest, presentationGrounding: { sourceTermCount: 8, matchedSourceTermCount: 7 } },
        storage,
      ),
    ).toBe(false);
  });

  it("rejects no-expiry pending approvals with malformed creation dates", async () => {
    const request = createToolInvokeRequest();
    const storage = createStorageWithPendingApproval({
      createdAt: "not-a-date",
      request: request as unknown as Record<string, unknown>,
    });

    expect(await hasVerifiedApprovalBypass(request, storage)).toBe(false);
  });

  it("rejects pending approvals until the canonical approval row is approved", async () => {
    const request = createToolInvokeRequest();
    const storage = createStorageWithPendingApproval({
      request: request as unknown as Record<string, unknown>,
      approvalStatus: "pending",
    });

    expect(await hasVerifiedApprovalBypass(request, storage)).toBe(false);
  });

  it("honors explicit pending approval expiry timestamps", async () => {
    const request = createToolInvokeRequest();

    expect(
      await hasVerifiedApprovalBypass(
        request,
        createStorageWithPendingApproval({
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          request: request as unknown as Record<string, unknown>,
        }),
      ),
    ).toBe(true);
    expect(
      await hasVerifiedApprovalBypass(
        request,
        createStorageWithPendingApproval({
          expiresAt: "not-a-date",
          request: request as unknown as Record<string, unknown>,
        }),
      ),
    ).toBe(false);
  });

  it("rejects missing approval reasons and mismatched pending approval records", async () => {
    const request = createToolInvokeRequest();

    expect(
      await hasVerifiedApprovalBypass({ ...request, consentContext: undefined }, createStorageWithPendingApproval()),
    ).toBe(false);
    expect(
      await hasVerifiedApprovalBypass(
        request,
        createStorageWithPendingApproval({ actionType: "chat.message" as PendingApprovalAction["actionType"] }),
      ),
    ).toBe(false);
    expect(
      await hasVerifiedApprovalBypass(
        request,
        createStorageWithPendingApproval({ resolutionStatus: "executed" as PendingApprovalAction["resolutionStatus"] }),
      ),
    ).toBe(false);
    expect(
      await hasVerifiedApprovalBypass(
        request,
        createStorageWithPendingApproval({
          request: {
            ...request,
            taskId: undefined,
          } as unknown as Record<string, unknown>,
        }),
      ),
    ).toBe(false);

    expect(
      await hasVerifiedApprovalBypass(
        createToolInvokeRequest({ args: undefined as unknown as Record<string, unknown> }),
        createStorageWithPendingApproval({
          request: createToolInvokeRequest({
            args: undefined as unknown as Record<string, unknown>,
          }) as unknown as Record<string, unknown>,
        }),
      ),
    ).toBe(true);
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
    expect(stripHtmlNoiseTags("before<custom>x</custom", ["custom"])).toBe("before ");
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

    expect(
      buildInternalToolCall(
        createToolInvokeRequest({
          toolName: "fs.read",
          authContext: {
            boundary: "provider_boundary",
            secretRefs: ["secret-1"],
          },
        }),
        deriveToolCapabilityPolicy("fs.read"),
        "2026-03-22T12:00:00.000Z",
      ).authContext,
    ).toEqual({
      boundary: "provider_boundary",
      secretRefs: ["secret-1"],
    });
  });

  it("resolves effective trust from source attribution for internal calls and audit records", () => {
    const request = createToolInvokeRequest({
      trustLevel: "trusted_operator",
      sourceAttribution: [
        {
          sourceType: "url",
          sourceRef: "https://example.com/prompt",
          title: "External prompt",
          backend: "native",
          trustLevel: "untrusted_external",
        },
      ],
    });
    const capabilityPolicy = deriveToolCapabilityPolicy(request.toolName);
    const call = buildInternalToolCall(request, capabilityPolicy, "2026-03-22T12:00:00.000Z");
    const audit = buildToolAuditRecord({
      auditEventId: "audit-1",
      request,
      outcome: "blocked",
      policyReason: "blocked",
      startedAt: "2026-03-22T12:00:00.000Z",
      completedAt: "2026-03-22T12:00:01.000Z",
    });

    expect(resolveToolTrustLevel(request)).toBe("untrusted_external");
    expect(call.trustLevel).toBe("untrusted_external");
    expect(call.sourceAttribution).toEqual([
      {
        sourceType: "url",
        sourceRef: "https://example.com/prompt",
        title: "External prompt",
        backend: "native",
        trustLevel: "untrusted_external",
      },
    ]);
    expect(audit.trustLevel).toBe("untrusted_external");
  });

  it("collects leak detections from strings and handles non-serializable inputs", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const presentation = {
      slides: [
        {
          speakerNotes:
            "Mechanism: make up means both compose matter and invent falsehoods. The punch line rewards a basic science fact without requiring specialized knowledge.",
        },
      ],
    };

    expect(collectLeakDetections("Bearer abcdefghijklmnopqrstuvwxyz")).toEqual(["bearer_token"]);
    expect(collectLeakDetections("Basic dXNlcjpwYXNz")).toEqual(["structured_secret"]);
    expect(collectLeakDetections(presentation)).toEqual([]);
    expect(collectLeakDetections(circular)).toEqual([]);
  });

  it("contains short and key-scoped secrets while preserving safe references and legacy labels", () => {
    const input = {
      webhookUrl: "https://example.test/hook?token=short-token",
      authorization: "Bearer short",
      DATABASE_PASSWORD: "tiny-secret",
    };
    const safeReferences = {
      tokenEnv: "WEBHOOK_TOKEN",
      secretRef: "keychain:webhook-token",
      tokenBudget: 4_096,
      tokenId: "runtime-token-identifier-123456",
    };

    expect(collectLeakDetections(input)).toEqual(["structured_secret"]);
    expect(collectLeakDetections("Bearer abcdefghijklmnopqrstuvwxyz")).toEqual(["bearer_token"]);
    expect(collectLeakDetections("keychain:webhook-token")).toEqual(["keychain_ref"]);
    expect(sanitizeForModel(input)).toEqual({
      webhookUrl: "[REDACTED]",
      authorization: "[REDACTED]",
      DATABASE_PASSWORD: "[REDACTED]",
    });
    expect(sanitizeForModel(safeReferences)).toEqual(safeReferences);
    expect(input.webhookUrl).toContain("short-token");
    expect(input.authorization).toBe("Bearer short");
    expect(input.DATABASE_PASSWORD).toBe("tiny-secret");
  });

  it("projects credential syntax hidden in safe metadata and channel URL paths without mutating input", () => {
    const codePreview = [
      "const tokenBudget = 1000;",
      "const tokenCount = 5;",
      "const passwordPolicy = true;",
      "const accessToken = getToken();",
    ].join("\n");
    const input = {
      secretRef: "password=hunter2",
      tokenId: "api_key=tiny-secret",
      sourceRef: "Authorization: Basic dXNlcjpwYXNz",
      cursor: "password=cursor-secret",
      error: "failure https://hooks.slack.com/services/T000/B000/abc12345",
      safeSecretRef: "keychain:webhook-token",
      runId: "run-secret-projection",
      nextCursor: "eyJwYWdlIjoyLCJ0b2tlbiI6InByb2plY3Rpb24ifQ==",
      codePreview,
      oauthMetadata: {
        authorizationUrl: "https://identity.example.test/oauth/authorize",
        tokenUrl: "https://identity.example.test/oauth/token",
      },
    };
    const original = structuredClone(input);
    const expected = {
      secretRef: "[REDACTED]",
      tokenId: "[REDACTED]",
      sourceRef: "Authorization: [REDACTED]",
      cursor: "password=[REDACTED]",
      error: "failure https://hooks.slack.com/services/[REDACTED]/[REDACTED]/[REDACTED]",
      safeSecretRef: "keychain:webhook-token",
      runId: "run-secret-projection",
      nextCursor: "eyJwYWdlIjoyLCJ0b2tlbiI6InByb2plY3Rpb24ifQ==",
      codePreview,
      oauthMetadata: {
        authorizationUrl: "https://identity.example.test/oauth/authorize",
        tokenUrl: "https://identity.example.test/oauth/token",
      },
    };

    expect(sanitizeForModel(input)).toEqual(expected);
    expect(sanitizeForAudit(input)).toEqual(expected);
    expect(input).toEqual(original);
  });

  it("does not classify typed binary assets or channel address schemes as secrets", () => {
    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

    expect(
      collectLeakDetections({
        target: "imessage:group@example.com",
        attachments: [{ mimeType: "image/png", dataBase64: pngBase64 }],
        visualAsset: { mimeType: "image/png", bytesBase64: pngBase64 },
      }),
    ).toEqual([]);
  });

  it("derives capability families for category-only and browser-control tools", () => {
    expect(deriveToolCapabilityPolicy("custom.research", { category: "research" }).family).toBe("network_read");
    expect(deriveToolCapabilityPolicy("memory.search").family).toBe("memory");
    expect(deriveToolCapabilityPolicy("mcp.invoke").family).toBe("mcp");
    expect(deriveToolCapabilityPolicy("browser.cookies.clear").family).toBe("browser_control");
    expect(deriveToolCapabilityPolicy("custom.comms", { category: "comms" })).toMatchObject({
      family: "comms",
      usesNetwork: true,
    });
    expect(deriveToolCapabilityPolicy("custom.git", { category: "git" }).family).toBe("git");
    expect(deriveToolCapabilityPolicy("custom.ops", { category: "ops" }).family).toBe("ops");
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

function createStorageWithPendingApproval(
  overrides: Partial<PendingApprovalAction> & { approvalStatus?: ApprovalRequest["status"] } = {},
): AsyncStorage {
  const { approvalStatus, ...pendingOverrides } = overrides;
  const pending: PendingApprovalAction = {
    approvalId: "approval-1",
    actionType: "tool.invoke",
    request: createToolInvokeRequest() as unknown as Record<string, unknown>,
    createdAt: new Date(Date.now() - 1_000).toISOString(),
    resolutionStatus: "pending",
    ...pendingOverrides,
  };

  return {
    approvals: {
      get: vi.fn(async (approvalId: string) =>
        createApprovalRequest({
          approvalId,
          status: approvalStatus ?? "approved",
        }),
      ),
    },
    pendingApprovalActions: {
      find: vi.fn(async () => pending),
      findFreshPending: vi.fn(async (_approvalId: string, defaultTtlMs: number) => {
        if (pending.resolutionStatus !== "pending") {
          return undefined;
        }
        const expiresAt = pending.expiresAt
          ? Date.parse(pending.expiresAt)
          : Date.parse(pending.createdAt) + defaultTtlMs;
        return Number.isFinite(expiresAt) && expiresAt > Date.now() ? pending : undefined;
      }),
    },
  } as unknown as AsyncStorage;
}

function createApprovalRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId: "approval-1",
    kind: "tool",
    riskLevel: "caution",
    status: "approved",
    payload: {},
    preview: {},
    createdAt: "2026-03-21T00:00:00.000Z",
    explanationStatus: "not_requested",
    ...overrides,
  };
}
