import { describe, expect, it, vi } from "vitest";
import type { PendingApprovalAction, ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { ToolPolicyEngine } from "./engine.js";

function createStorageStub(): Storage {
  return {
    approvals: {
      create: vi.fn((input) => ({
        approvalId: "approval-1",
        kind: input.kind,
        riskLevel: input.riskLevel,
        status: "pending",
        payload: input.payload,
        preview: input.preview,
        createdAt: "2026-03-22T12:00:00.000Z",
        expiresAt: input.expiresAt ?? undefined,
        explanationStatus: "not_requested",
      })),
    },
    approvalEvents: {
      append: vi.fn(),
    },
    audit: {
      append: vi.fn(async () => undefined),
    },
    toolAccessDecisions: {
      record: vi.fn(),
      countToolCallsInLastHourInScope: vi.fn(() => 0),
      countWritesInLastHourInScope: vi.fn(() => 0),
    },
    toolGrants: {
      list: vi.fn(() => []),
    },
    pendingApprovalActions: {
      upsertPending: vi.fn(),
      find: vi.fn(() => undefined),
      markResolved: vi.fn(),
    },
    db: {
      prepare: vi.fn(() => ({
        run: vi.fn(),
      })),
    },
  } as unknown as Storage;
}

const policyConfig: ToolPolicyConfig = {
  profiles: {
    danger: ["*"],
  },
  tools: {
    profile: "danger",
    approvalMode: "approve_risky",
    allow: [],
    deny: [],
  },
  agents: {},
  sandbox: {
    writeJailRoots: ["./workspace"],
    readOnlyRoots: ["./skills"],
    networkAllowlist: ["localhost"],
    riskyShellPatterns: [],
    requireApprovalForRiskyShell: true,
  },
};

describe("ToolPolicyEngine bankr migration gating", () => {
  it("blocks bankr tools when built-in support is disabled", () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(policyConfig, storage, undefined, {
      isBankrBuiltinEnabled: () => false,
    });
    const evaluation = engine.evaluateAccess({
      toolName: "bankr.write",
      args: {},
      agentId: "agent",
      sessionId: "session",
    });
    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toContain("bankr_builtin_disabled");
  });

  it("hides bankr tools from catalog when built-in support is disabled", () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(policyConfig, storage, undefined, {
      isBankrBuiltinEnabled: () => false,
    });
    const catalog = engine.listCatalog();
    expect(catalog.some((tool) => tool.toolName.startsWith("bankr."))).toBe(false);
  });

  it("keeps bankr tools in the catalog when built-in support is enabled", () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(policyConfig, storage, undefined, {
      isBankrBuiltinEnabled: () => true,
    });

    expect(engine.listCatalog().some((tool) => tool.toolName.startsWith("bankr."))).toBe(true);
  });

  it("passes grant list, create, and revoke operations through to storage", () => {
    const storage = createStorageStub();
    const grant = {
      grantId: "grant-1",
      toolPattern: "fs.read",
      decision: "allow",
      scope: "session",
      scopeRef: "session",
      grantType: "persistent",
      createdBy: "test",
      createdAt: "2026-03-22T12:00:00.000Z",
    } as const;
    Object.assign(storage.toolGrants, {
      list: vi.fn(() => [grant]),
      create: vi.fn(() => grant),
      revoke: vi.fn(() => true),
    });
    const engine = new ToolPolicyEngine(policyConfig, storage);

    expect(engine.listGrants("session", "session", 5)).toEqual([grant]);
    expect(engine.createGrant(grant)).toBe(grant);
    expect(engine.revokeGrant("grant-1")).toBe(true);
    expect(storage.toolGrants.list).toHaveBeenCalledWith("session", "session", 5);
    expect(storage.toolGrants.create).toHaveBeenCalledWith(grant);
    expect(storage.toolGrants.revoke).toHaveBeenCalledWith("grant-1");
  });
});

describe("ToolPolicyEngine invocation coverage", () => {
  it("returns a dry-run execution result without calling the tool executor", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(policyConfig, storage);

    const result = await engine.invoke({
      toolName: "session.status",
      args: {},
      agentId: "agent",
      sessionId: "session",
      dryRun: true,
    });

    expect(result).toMatchObject({
      outcome: "executed",
      result: {
        dryRun: true,
        toolName: "session.status",
      },
    });
    expect(result.internalResult).toMatchObject({
      outcome: "executed",
      result: {
        dryRun: true,
      },
    });
  });

  it("records execution errors from tools that pass policy but fail at runtime", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          approvalMode: "bypass",
        },
      },
      storage,
    );

    const result = await engine.invoke({
      toolName: "custom.allowed",
      args: {},
      agentId: "agent",
      sessionId: "session",
    });

    expect(result.outcome).toBe("blocked");
    expect(result.policyReason).toContain("Unsupported tool executor: custom.allowed");
    expect(result.internalResult).toMatchObject({
      outcome: "blocked",
      errorKind: "execution_error",
    });
  });

  it("records blocked approved actions when policy changes after approval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    try {
      const storage = createStorageStub();
      vi.mocked(storage.pendingApprovalActions.find).mockReturnValue(
        createPendingApprovalAction({
          approvalId: "apr-bankr-disabled",
          expiresAt: "2026-03-21T00:10:00.000Z",
          request: {
            toolName: "bankr.write",
            args: { prompt: "transfer funds", actionType: "transfer" },
            agentId: "agent",
            sessionId: "session",
          },
        }),
      );
      const engine = new ToolPolicyEngine(policyConfig, storage, undefined, {
        isBankrBuiltinEnabled: () => false,
      });

      const result = await engine.executeApprovedAction("apr-bankr-disabled");

      expect(result).toMatchObject({
        outcome: "blocked",
        internalResult: {
          outcome: "blocked",
          errorKind: "policy_block",
        },
      });
      expect(result?.policyReason).toContain("Bankr built-in is disabled");
      expect(storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
        "apr-bankr-disabled",
        "failed",
        expect.objectContaining({
          reason: expect.stringContaining("Bankr built-in is disabled"),
        }),
      );
      expect(storage.approvalEvents.append).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalId: "apr-bankr-disabled",
          eventType: "approved_action_executed",
          payload: expect.objectContaining({ outcome: "blocked" }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("includes target and shell command details in approval previews", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["example.com"],
        },
      },
      storage,
    );

    await engine.invoke({
      toolName: "http.post",
      args: { url: "https://example.com/api", body: { query: "status" } },
      agentId: "agent",
      sessionId: "session",
      taskId: "task-http",
    });
    await engine.invoke({
      toolName: "shell.exec",
      args: { command: "echo hello" },
      agentId: "agent",
      sessionId: "session",
      taskId: "task-shell",
    });

    expect(storage.approvals.create).toHaveBeenCalledWith(
      expect.objectContaining({
        preview: expect.objectContaining({
          target: "https://example.com/api",
        }),
      }),
    );
    expect(storage.approvals.create).toHaveBeenCalledWith(
      expect.objectContaining({
        preview: expect.objectContaining({
          command: "echo hello",
        }),
      }),
    );
  });
});

describe("ToolPolicyEngine policy edge coverage", () => {
  it("reports explicit policy denies, unknown tools, and profile disallows", () => {
    const denyStorage = createStorageStub();
    const denyEngine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          deny: ["session.status"],
        },
      },
      denyStorage,
    );

    expect(
      denyEngine.evaluateAccess({
        toolName: "session.status",
        args: {},
        agentId: "agent",
        sessionId: "session",
      }).reasonCodes,
    ).toEqual(["policy_deny"]);

    const emptyProfileConfig: ToolPolicyConfig = {
      ...policyConfig,
      profiles: {
        minimal: [],
      },
      tools: {
        ...policyConfig.tools,
        profile: "minimal",
        allow: [],
        deny: [],
      },
    };
    const unknownEngine = new ToolPolicyEngine(emptyProfileConfig, createStorageStub());
    expect(
      unknownEngine.evaluateAccess({
        toolName: "custom.unknown",
        args: {},
        agentId: "agent",
        sessionId: "session",
      }).reasonCodes,
    ).toEqual(["unknown_tool"]);

    const disallowEngine = new ToolPolicyEngine(emptyProfileConfig, createStorageStub());
    expect(
      disallowEngine.evaluateAccess({
        toolName: "session.status",
        args: {},
        agentId: "agent",
        sessionId: "session",
      }).reasonCodes,
    ).toEqual(["policy_disallow"]);
  });

  it("marks approve-all, nuclear, and risky shell requests for approval", () => {
    const approveAllEngine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          approvalMode: "approve_all",
        },
      },
      createStorageStub(),
    );
    expect(
      approveAllEngine.evaluateAccess({
        toolName: "session.status",
        args: {},
        agentId: "agent",
        sessionId: "session",
      }).reasonCodes,
    ).toContain("approval_mode_all");

    const bankrEngine = new ToolPolicyEngine(
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["api.bankr.bot"],
        },
      },
      createStorageStub(),
      undefined,
      {
        isBankrBuiltinEnabled: () => true,
      },
    );
    const bankrEvaluation = bankrEngine.evaluateAccess({
      toolName: "bankr.write",
      args: { prompt: "transfer funds", actionType: "transfer" },
      agentId: "agent",
      sessionId: "session",
    });
    expect(bankrEvaluation.allowed).toBe(true);
    expect(bankrEvaluation.requiresApproval).toBe(true);

    const shellEngine = new ToolPolicyEngine(
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          riskyShellPatterns: ["rm -rf"],
        },
      },
      createStorageStub(),
    );
    expect(
      shellEngine.evaluateAccess({
        toolName: "shell.exec",
        args: { command: "rm -rf ./workspace/tmp" },
        agentId: "agent",
        sessionId: "session",
      }).reasonCodes,
    ).toContain("shell_risky_requires_approval");
    expect(
      shellEngine.evaluateAccess({
        toolName: "shell.exec",
        args: { command: "   " },
        agentId: "agent",
        sessionId: "session",
      }).allowed,
    ).toBe(true);
  });

  it("filters inactive grants before selecting the active scoped fallback", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    try {
      const storage = createStorageStub();
      vi.mocked(storage.toolGrants.list).mockImplementation((scope, scopeRef) => {
        if (scope === "session" && scopeRef === "session") {
          return [
            {
              grantId: "grant-revoked",
              toolPattern: "session.status",
              decision: "allow",
              scope,
              scopeRef,
              grantType: "persistent",
              revokedAt: "2026-03-21T00:00:00.000Z",
              createdBy: "test",
              createdAt: "2026-03-21T00:00:00.000Z",
            },
            {
              grantId: "grant-expired",
              toolPattern: "session.status",
              decision: "allow",
              scope,
              scopeRef,
              grantType: "persistent",
              expiresAt: "2026-03-21T00:01:00.000Z",
              createdBy: "test",
              createdAt: "2026-03-21T00:00:00.000Z",
            },
            {
              grantId: "grant-depleted",
              toolPattern: "session.status",
              decision: "allow",
              scope,
              scopeRef,
              grantType: "persistent",
              usesRemaining: 0,
              createdBy: "test",
              createdAt: "2026-03-21T00:00:00.000Z",
            },
          ];
        }
        if (scope === "global" && scopeRef === "global") {
          return [
            {
              grantId: "grant-global-active",
              toolPattern: "session.status",
              decision: "allow",
              scope,
              scopeRef,
              grantType: "persistent",
              createdBy: "test",
              createdAt: "2026-03-21T00:00:00.000Z",
            },
          ];
        }
        return [];
      });
      const engine = new ToolPolicyEngine(
        {
          ...policyConfig,
          profiles: {
            minimal: [],
          },
          tools: {
            ...policyConfig.tools,
            profile: "minimal",
          },
        },
        storage,
      );

      const evaluation = engine.evaluateAccess({
        toolName: "session.status",
        args: {},
        agentId: "agent",
        sessionId: "session",
      });

      expect(evaluation.allowed).toBe(true);
      expect(evaluation.matchedGrantId).toBe("grant-global-active");
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies read-path and grant candidate extraction edge cases", () => {
    const docsEngine = new ToolPolicyEngine(policyConfig, createStorageStub());
    expect(
      docsEngine.evaluateAccess({
        toolName: "docs.ingest",
        args: { sourceType: "file", source: "F:/outside/project/spec.md", namespace: "docs" },
        agentId: "agent",
        sessionId: "session",
      }).reasonCodes,
    ).toEqual(["structural_safety_block"]);
    expect(
      docsEngine.evaluateAccess({
        toolName: "fs.copy",
        args: { from: "F:/outside/project/spec.md", to: "./workspace/spec.md" },
        agentId: "agent",
        sessionId: "session",
      }).reasonCodes,
    ).toEqual(["structural_safety_block"]);

    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockReturnValue([
      {
        grantId: "grant-custom",
        toolPattern: "http.get",
        decision: "allow",
        scope: "session",
        scopeRef: "session",
        grantType: "persistent",
        constraints: {
          allowedHosts: ["example.com"],
          allowedPaths: ["./workspace"],
          referenceRoots: [
            {
              label: "ref",
              rootPath: "./reference",
              access: "read_only",
            },
          ],
        },
        createdBy: "test",
        createdAt: new Date().toISOString(),
      },
    ]);
    const grantEngine = new ToolPolicyEngine(
      {
        ...policyConfig,
        profiles: {
          minimal: [],
        },
        tools: {
          ...policyConfig.tools,
          profile: "minimal",
          approvalMode: "bypass",
        },
      },
      storage,
    );

    expect(
      grantEngine.evaluateAccess({
        toolName: "http.get",
        agentId: "agent",
        sessionId: "session",
      } as never).allowed,
    ).toBe(true);
  });

  it("extracts outbound hosts for bypass-mode dry runs without auditing allowlisted targets", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          approvalMode: "bypass",
        },
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["example.com", "api.bankr.bot", "llm.bankr.bot", "127.0.0.1:3002"],
        },
      },
      storage,
      undefined,
      {
        isBankrBuiltinEnabled: () => true,
      },
    );

    await engine.invoke({
      toolName: "http.get",
      args: { host: "example.com" },
      agentId: "agent",
      sessionId: "session",
      dryRun: true,
    });
    await engine.invoke({
      toolName: "bankr.read",
      args: { prompt: "show balance", actionType: "read", useLlmGateway: true },
      agentId: "agent",
      sessionId: "session",
      dryRun: true,
    });
    await engine.invoke({
      toolName: "docs.ingest",
      args: {
        sourceType: "url",
        source: "https://example.com/doc",
        namespace: "research",
        backend: "firecrawl",
        firecrawlBaseUrl: "http://127.0.0.1:3002",
      },
      agentId: "agent",
      sessionId: "session",
      dryRun: true,
    });
    await engine.invoke({
      toolName: "browser.navigate",
      args: { url: "https://example.com/page" },
      agentId: "agent",
      sessionId: "session",
      dryRun: true,
    });

    expect(storage.audit.append).not.toHaveBeenCalledWith(
      "tool_invocations",
      expect.objectContaining({ event: "approval_bypass_mode_network_target" }),
    );
  });

  it("covers read modes, grant consumption, and host constraint variants", async () => {
    const rootsEngine = new ToolPolicyEngine(policyConfig, createStorageStub());
    expect(
      rootsEngine.evaluateAccess({
        toolName: "fs.read",
        args: { path: "./workspace/note.txt" },
        agentId: "agent",
        sessionId: "session",
      }).allowed,
    ).toBe(true);

    const fullDiskEngine = new ToolPolicyEngine(
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          readAccessMode: "full_disk",
        },
      },
      createStorageStub(),
    );
    expect(
      fullDiskEngine.evaluateAccess({
        toolName: "fs.read",
        args: { path: "F:/outside/note.txt" },
        agentId: "agent",
        sessionId: "session",
      }).allowed,
    ).toBe(true);

    const consumeStorage = createStorageStub();
    Object.assign(consumeStorage.toolGrants, {
      list: vi.fn(() => [
        {
          grantId: "grant-consume",
          toolPattern: "session.status",
          decision: "allow",
          scope: "session",
          scopeRef: "session",
          grantType: "temporary",
          usesRemaining: 1,
          createdBy: "test",
          createdAt: new Date().toISOString(),
        },
      ]),
      consumeOne: vi.fn(),
    });
    const consumeEngine = new ToolPolicyEngine(policyConfig, consumeStorage);
    await consumeEngine.invoke({
      toolName: "session.status",
      args: {},
      agentId: "agent",
      sessionId: "session",
    });
    expect(consumeStorage.toolGrants.consumeOne).toHaveBeenCalledWith("grant-consume");

    const hostStorage = createStorageStub();
    const hostGrant = {
      grantId: "grant-host",
      toolPattern: "http.get",
      decision: "allow",
      scope: "session",
      scopeRef: "session",
      grantType: "persistent",
      createdBy: "test",
      createdAt: new Date().toISOString(),
    } as const;
    const hostEngine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          approvalMode: "bypass",
        },
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["api.example.com"],
        },
      },
      hostStorage,
    );

    vi.mocked(hostStorage.toolGrants.list).mockReturnValue([{ ...hostGrant, constraints: { allowedHosts: [""] } }]);
    expect(
      hostEngine.evaluateAccess({
        toolName: "http.get",
        args: { host: "api.example.com" },
        agentId: "agent",
        sessionId: "session",
      }).reasonCodes,
    ).toEqual(["grant_constraints_block"]);

    vi.mocked(hostStorage.toolGrants.list).mockReturnValue([{ ...hostGrant, constraints: { allowedHosts: ["*"] } }]);
    expect(
      hostEngine.evaluateAccess({
        toolName: "http.get",
        args: { host: "api.example.com" },
        agentId: "agent",
        sessionId: "session",
      }).allowed,
    ).toBe(true);

    vi.mocked(hostStorage.toolGrants.list).mockReturnValue([
      { ...hostGrant, constraints: { allowedHosts: ["api.example.com"] } },
    ]);
    expect(
      hostEngine.evaluateAccess({
        toolName: "http.get",
        args: { host: "api.example.com" },
        agentId: "agent",
        sessionId: "session",
      }).allowed,
    ).toBe(true);

    vi.mocked(hostStorage.toolGrants.list).mockReturnValue([
      {
        ...hostGrant,
        constraints: {
          allowedPaths: [null as unknown as string],
        },
      },
    ]);
    expect(
      hostEngine.evaluateAccess({
        toolName: "http.get",
        args: { path: "./workspace/note.txt" },
        agentId: "agent",
        sessionId: "session",
      }).reasonCodes,
    ).toEqual(["grant_constraints_block"]);
  });

  it("covers unknown in-profile grants and approved action payload parsing", async () => {
    const customStorage = createStorageStub();
    vi.mocked(customStorage.toolGrants.list).mockReturnValue([
      {
        grantId: "grant-custom",
        toolPattern: "custom.allowed",
        decision: "allow",
        scope: "session",
        scopeRef: "session",
        grantType: "persistent",
        constraints: {
          referenceRoots: [
            {
              label: "ref",
              rootPath: "./reference",
              access: "read_only",
            },
          ],
        },
        createdBy: "test",
        createdAt: new Date().toISOString(),
      },
    ]);
    const customEngine = new ToolPolicyEngine(policyConfig, customStorage);
    expect(
      customEngine.evaluateAccess({
        toolName: "custom.allowed",
        args: { path: "./reference/note.txt" },
        agentId: "agent",
        sessionId: "session",
      }).allowed,
    ).toBe(true);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    try {
      const storage = createStorageStub();
      vi.mocked(storage.pendingApprovalActions.find).mockReturnValue(
        createPendingApprovalAction({
          approvalId: "apr-context",
          expiresAt: "2026-03-21T00:10:00.000Z",
          request: {
            toolName: "session.status",
            args: {},
            agentId: "agent",
            sessionId: "session",
            consentContext: {
              operatorId: "operator-1",
              source: "agent",
              reason: "initial request",
            },
          },
        }),
      );
      const engine = new ToolPolicyEngine(policyConfig, storage);
      const result = await engine.executeApprovedAction("apr-context");
      expect(result).toMatchObject({
        outcome: "executed",
        result: {
          sessionId: "session",
          status: "ok",
        },
      });

      vi.mocked(storage.pendingApprovalActions.find).mockReturnValue(
        createPendingApprovalAction({
          approvalId: "apr-non-string-context",
          expiresAt: "2026-03-21T00:10:00.000Z",
          request: {
            toolName: "session.status",
            args: {},
            agentId: "agent",
            sessionId: "session",
            consentContext: {
              operatorId: 42,
              source: "ui",
              reason: 42,
            },
          },
        }),
      );
      await expect(engine.executeApprovedAction("apr-non-string-context")).resolves.toMatchObject({
        outcome: "executed",
      });

      vi.mocked(storage.pendingApprovalActions.find).mockReturnValue(
        createPendingApprovalAction({
          approvalId: "apr-invalid-payload",
          expiresAt: "2026-03-21T00:10:00.000Z",
          request: {
            args: {},
            agentId: "agent",
            sessionId: "session",
          },
        }),
      );
      await expect(engine.executeApprovedAction("apr-invalid-payload")).rejects.toThrow(
        "Invalid pending action request payload",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("stores an empty pending request when an approval-gated request has a defensive array shape", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(policyConfig, storage);
    const arrayBackedRequest = [] as unknown as ToolInvokeRequest;
    Object.assign(arrayBackedRequest, {
      toolName: "shell.exec",
      args: { command: "echo hello" },
      agentId: "agent",
      sessionId: "session",
    });

    await expect(engine.invoke(arrayBackedRequest)).resolves.toMatchObject({
      outcome: "approval_required",
    });
    expect(storage.pendingApprovalActions.upsertPending).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {},
      }),
    );
  });

  it("records the bypass network audit event for public targets that would otherwise need approval", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          approvalMode: "bypass",
        },
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["localhost"],
        },
      },
      storage,
    );

    await (
      engine as unknown as {
        recordDangerProfileNetworkBypassIfNeeded: (
          auditEventId: string,
          request: {
            toolName: string;
            args: Record<string, unknown>;
            agentId: string;
            sessionId: string;
            taskId?: string;
          },
        ) => Promise<void>;
      }
    ).recordDangerProfileNetworkBypassIfNeeded("audit-network", {
      toolName: "http.get",
      args: { url: "https://example.com/api" },
      agentId: "agent",
      sessionId: "session",
      taskId: "task",
    });

    expect(storage.audit.append).toHaveBeenCalledWith(
      "tool_invocations",
      expect.objectContaining({
        auditEventId: "audit-network",
        event: "approval_bypass_mode_network_target",
        targets: [
          expect.objectContaining({
            target: "https://example.com/api",
            hostname: "example.com",
          }),
        ],
      }),
    );
  });
});

describe("ToolPolicyEngine outside-root read access", () => {
  it("blocks browser navigation to public hosts when they are not allowlisted even in bypass mode", () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockReturnValue([
      {
        grantId: "grant-browser-navigate",
        toolPattern: "browser.navigate",
        decision: "allow",
        scope: "session",
        scopeRef: "session",
        grantType: "persistent",
        createdBy: "test",
        createdAt: new Date().toISOString(),
      },
    ]);
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          approvalMode: "bypass",
          allow: [],
        },
      },
      storage,
    );

    const evaluation = engine.evaluateAccess({
      toolName: "browser.navigate",
      args: { url: "https://apnews.com/oddities" },
      agentId: "agent",
      sessionId: "session",
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.requiresApproval).toBe(false);
    expect(evaluation.reasonCodes).toContain("structural_safety_block");
  });

  it("still blocks metadata hosts under the danger profile", () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          approvalMode: "bypass",
          allow: [],
        },
      },
      storage,
    );

    const evaluation = engine.evaluateAccess({
      toolName: "browser.navigate",
      args: { url: "http://169.254.169.254/latest/meta-data" },
      agentId: "agent",
      sessionId: "session",
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toContain("structural_safety_block");
  });

  it("does not audit public-host bypasses because bypass mode preserves the network allowlist", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          approvalMode: "bypass",
          allow: [],
        },
      },
      storage,
    );

    vi.mocked(storage.toolGrants.list).mockReturnValue([
      {
        grantId: "grant-browser-navigate",
        toolPattern: "browser.navigate",
        decision: "allow",
        scope: "session",
        scopeRef: "session",
        grantType: "persistent",
        createdBy: "test",
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await engine.invoke({
      toolName: "browser.navigate",
      args: { url: "https://apnews.com/oddities" },
      agentId: "agent",
      sessionId: "session",
      dryRun: true,
    });

    expect(result.outcome).toBe("blocked");
    expect(vi.mocked(storage.audit.append)).not.toHaveBeenCalledWith(
      "tool_invocations",
      expect.objectContaining({ event: "approval_bypass_mode_network_target" }),
    );
  });

  it("persists a default approval expiry when a tool action is gated", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T12:00:00.000Z"));
    try {
      const storage = createStorageStub();
      const engine = new ToolPolicyEngine(
        {
          ...policyConfig,
          sandbox: {
            ...policyConfig.sandbox,
            readAccessMode: "approval_required",
          },
        },
        storage,
      );

      const result = await engine.invoke({
        toolName: "file.read_range",
        args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
        agentId: "agent",
        sessionId: "session",
      });

      expect(result.outcome).toBe("approval_required");
      expect(result.expiresAt).toBe("2026-03-22T12:15:00.000Z");
      expect(vi.mocked(storage.approvals.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          expiresAt: "2026-03-22T12:15:00.000Z",
        }),
      );
      expect(vi.mocked(storage.pendingApprovalActions.upsertPending)).toHaveBeenCalledWith(
        expect.objectContaining({
          expiresAt: "2026-03-22T12:15:00.000Z",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires approval when readAccessMode is approval_required and a file is outside trusted roots", () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          readAccessMode: "approval_required",
        },
      },
      storage,
    );
    const evaluation = engine.evaluateAccess({
      toolName: "file.read_range",
      args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
      agentId: "agent",
      sessionId: "session",
    });
    expect(evaluation.allowed).toBe(true);
    expect(evaluation.requiresApproval).toBe(true);
    expect(evaluation.reasonCodes).toContain("outside_roots_read_requires_approval");
  });

  it("allows outside-root reads when a scoped grant includes a wildcard allowed path", () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockReturnValue([
      {
        grantId: "grant-1",
        toolPattern: "file.read_range",
        decision: "allow",
        scope: "session",
        scopeRef: "session",
        grantType: "persistent",
        constraints: {
          allowedPaths: ["*"],
        },
        createdBy: "test",
        createdAt: new Date().toISOString(),
      },
    ]);
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          readAccessMode: "approval_required",
        },
      },
      storage,
    );
    const evaluation = engine.evaluateAccess({
      toolName: "file.read_range",
      args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
      agentId: "agent",
      sessionId: "session",
    });
    expect(evaluation.allowed).toBe(true);
    expect(evaluation.requiresApproval).toBe(false);
  });

  it("allows approved read-only reference roots without approval churn", () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockReturnValue([
      {
        grantId: "grant-reference-root",
        toolPattern: "file.read_range",
        decision: "allow",
        scope: "session",
        scopeRef: "session",
        grantType: "persistent",
        constraints: {
          referenceRoots: [
            {
              label: "claude-code-reference",
              rootPath: "F:\\code\\claude-code",
              access: "read_only",
            },
          ],
        },
        createdBy: "test",
        createdAt: new Date().toISOString(),
      },
    ]);
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          readAccessMode: "approval_required",
        },
      },
      storage,
    );
    const evaluation = engine.evaluateAccess({
      toolName: "file.read_range",
      args: { path: "F:/code/claude-code/src/index.ts", startLine: 1, endLine: 5 },
      agentId: "agent",
      sessionId: "session",
    });
    expect(evaluation.allowed).toBe(true);
    expect(evaluation.requiresApproval).toBe(false);
  });

  it("does not allow approved read-only reference roots to escape through parent segments", () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockReturnValue([
      {
        grantId: "grant-reference-root",
        toolPattern: "file.read_range",
        decision: "allow",
        scope: "session",
        scopeRef: "session",
        grantType: "persistent",
        constraints: {
          referenceRoots: [
            {
              label: "claude-code-reference",
              rootPath: "F:\\code\\claude-code",
              access: "read_only",
            },
          ],
        },
        createdBy: "test",
        createdAt: new Date().toISOString(),
      },
    ]);
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          readAccessMode: "approval_required",
        },
      },
      storage,
    );
    const evaluation = engine.evaluateAccess({
      toolName: "file.read_range",
      args: { path: "F:/code/claude-code/../private/file.ts", startLine: 1, endLine: 5 },
      agentId: "agent",
      sessionId: "session",
    });
    expect(evaluation.allowed).toBe(true);
    expect(evaluation.requiresApproval).toBe(true);
  });

  it("does not bypass outside-root read approval with a forged approval id", () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          readAccessMode: "approval_required",
        },
      },
      storage,
    );
    const evaluation = engine.evaluateAccess({
      toolName: "file.read_range",
      args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
      agentId: "agent",
      sessionId: "session",
      consentContext: {
        source: "ui",
        reason: "approval:apr-forged",
      },
    } as never);
    expect(evaluation.allowed).toBe(true);
    expect(evaluation.requiresApproval).toBe(true);
  });

  it("allows outside-root reads only when the approval id matches a fresh pending approved action request", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    const storage = createStorageStub();
    try {
      vi.mocked(storage.pendingApprovalActions.find).mockReturnValue(
        createPendingApprovalAction({
          approvalId: "apr-123",
          expiresAt: "2026-03-21T00:10:00.000Z",
          request: {
            toolName: "file.read_range",
            args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
            agentId: "agent",
            sessionId: "session",
            consentContext: {
              source: "ui",
              reason: "approval:apr-123",
            },
          },
        }),
      );
      const engine = new ToolPolicyEngine(
        {
          ...policyConfig,
          sandbox: {
            ...policyConfig.sandbox,
            readAccessMode: "approval_required",
          },
        },
        storage,
      );
      const evaluation = engine.evaluateAccess({
        toolName: "file.read_range",
        args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
        agentId: "agent",
        sessionId: "session",
        consentContext: {
          source: "ui",
          reason: "approval:apr-123",
        },
      } as never);
      expect(evaluation.allowed).toBe(true);
      expect(evaluation.requiresApproval).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects outside-root approval bypasses after expiry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:20:00.000Z"));
    try {
      const storage = createStorageStub();
      vi.mocked(storage.pendingApprovalActions.find).mockReturnValue(
        createPendingApprovalAction({
          approvalId: "apr-expired",
          expiresAt: "2026-03-21T00:10:00.000Z",
          request: {
            toolName: "file.read_range",
            args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
            agentId: "agent",
            sessionId: "session",
          },
        }),
      );
      const engine = new ToolPolicyEngine(
        {
          ...policyConfig,
          sandbox: {
            ...policyConfig.sandbox,
            readAccessMode: "approval_required",
          },
        },
        storage,
      );
      const evaluation = engine.evaluateAccess({
        toolName: "file.read_range",
        args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
        agentId: "agent",
        sessionId: "session",
        consentContext: {
          source: "ui",
          reason: "approval:apr-expired",
        },
      } as never);
      expect(evaluation.allowed).toBe(true);
      expect(evaluation.requiresApproval).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects outside-root approval bypasses after the pending action is resolved", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    try {
      const storage = createStorageStub();
      vi.mocked(storage.pendingApprovalActions.find).mockReturnValue({
        ...createPendingApprovalAction({
          approvalId: "apr-executed",
          expiresAt: "2026-03-21T00:10:00.000Z",
          request: {
            toolName: "file.read_range",
            args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
            agentId: "agent",
            sessionId: "session",
          },
        }),
        resolutionStatus: "executed",
      });
      const engine = new ToolPolicyEngine(
        {
          ...policyConfig,
          sandbox: {
            ...policyConfig.sandbox,
            readAccessMode: "approval_required",
          },
        },
        storage,
      );
      const evaluation = engine.evaluateAccess({
        toolName: "file.read_range",
        args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
        agentId: "agent",
        sessionId: "session",
        consentContext: {
          source: "ui",
          reason: "approval:apr-executed",
        },
      } as never);
      expect(evaluation.allowed).toBe(true);
      expect(evaluation.requiresApproval).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows legacy pending approval bypasses only inside the default ttl from createdAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:14:00.000Z"));
    try {
      const storage = createStorageStub();
      vi.mocked(storage.pendingApprovalActions.find).mockReturnValue(
        createPendingApprovalAction({
          approvalId: "apr-legacy",
          createdAt: "2026-03-21T00:00:00.000Z",
          request: {
            toolName: "file.read_range",
            args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
            agentId: "agent",
            sessionId: "session",
          },
        }),
      );
      const engine = new ToolPolicyEngine(
        {
          ...policyConfig,
          sandbox: {
            ...policyConfig.sandbox,
            readAccessMode: "approval_required",
          },
        },
        storage,
      );
      const evaluation = engine.evaluateAccess({
        toolName: "file.read_range",
        args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
        agentId: "agent",
        sessionId: "session",
        consentContext: {
          source: "ui",
          reason: "approval:apr-legacy",
        },
      } as never);
      expect(evaluation.requiresApproval).toBe(false);

      vi.setSystemTime(new Date("2026-03-21T00:16:00.000Z"));
      const expiredEvaluation = engine.evaluateAccess({
        toolName: "file.read_range",
        args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
        agentId: "agent",
        sessionId: "session",
        consentContext: {
          source: "ui",
          reason: "approval:apr-legacy",
        },
      } as never);
      expect(expiredEvaluation.requiresApproval).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects pending approval bypasses with invalid explicit expiry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    try {
      const storage = createStorageStub();
      vi.mocked(storage.pendingApprovalActions.find).mockReturnValue(
        createPendingApprovalAction({
          approvalId: "apr-invalid-expiry",
          createdAt: "2026-03-21T00:00:00.000Z",
          expiresAt: "not-a-date",
          request: {
            toolName: "file.read_range",
            args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
            agentId: "agent",
            sessionId: "session",
          },
        }),
      );
      const engine = new ToolPolicyEngine(
        {
          ...policyConfig,
          sandbox: {
            ...policyConfig.sandbox,
            readAccessMode: "approval_required",
          },
        },
        storage,
      );
      const evaluation = engine.evaluateAccess({
        toolName: "file.read_range",
        args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
        agentId: "agent",
        sessionId: "session",
        consentContext: {
          source: "ui",
          reason: "approval:apr-invalid-expiry",
        },
      } as never);
      expect(evaluation.requiresApproval).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not execute approved pending actions after expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:20:00.000Z"));
    try {
      const storage = createStorageStub();
      vi.mocked(storage.pendingApprovalActions.find).mockReturnValue(
        createPendingApprovalAction({
          approvalId: "apr-expired-direct",
          expiresAt: "2026-03-21T00:10:00.000Z",
          request: {
            toolName: "file.read_range",
            args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
            agentId: "agent",
            sessionId: "session",
          },
        }),
      );
      const engine = new ToolPolicyEngine(
        {
          ...policyConfig,
          sandbox: {
            ...policyConfig.sandbox,
            readAccessMode: "approval_required",
          },
        },
        storage,
      );
      const result = await engine.executeApprovedAction("apr-expired-direct");
      expect(result).toBeUndefined();
      expect(storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith("apr-expired-direct", "failed", {
        reason: "pending approval action is expired, resolved, or no longer matches the stored request",
      });
      expect(storage.audit.append).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores missing and unsupported pending approval actions", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(policyConfig, storage);

    await expect(engine.executeApprovedAction("missing")).resolves.toBeUndefined();

    vi.mocked(storage.pendingApprovalActions.find).mockReturnValue({
      ...createPendingApprovalAction({
        approvalId: "apr-chat",
        request: { toolName: "session.status", args: {}, agentId: "agent", sessionId: "session" },
      }),
      actionType: "chat.send" as never,
    });

    await expect(engine.executeApprovedAction("apr-chat")).resolves.toBeUndefined();
    expect(storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith("apr-chat", "failed", {
      error: "unsupported pending action type chat.send",
    });
  });

  it("executes a fresh approved pending action and marks it resolved", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    try {
      const storage = createStorageStub();
      vi.mocked(storage.pendingApprovalActions.find).mockReturnValue(
        createPendingApprovalAction({
          approvalId: "apr-session",
          expiresAt: "2026-03-21T00:10:00.000Z",
          request: {
            toolName: "session.status",
            args: {},
            agentId: "agent",
            sessionId: "session",
          },
        }),
      );
      const engine = new ToolPolicyEngine(policyConfig, storage);

      const result = await engine.executeApprovedAction("apr-session", new AbortController().signal);

      expect(result).toMatchObject({
        outcome: "executed",
        policyReason: "allowed_via_approval:apr-session",
        result: {
          sessionId: "session",
          status: "ok",
        },
      });
      expect(storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
        "apr-session",
        "executed",
        expect.objectContaining({
          outcome: "executed",
        }),
      );
      expect(storage.approvalEvents.append).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalId: "apr-session",
          eventType: "approved_action_executed",
          payload: expect.objectContaining({ outcome: "executed" }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ToolPolicyEngine scoped mutation gating", () => {
  it("treats task-scoped grants as first mutation per task instead of per session", () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockImplementation((scope, scopeRef) => {
      if (scope === "task" && scopeRef === "task-2") {
        return [
          {
            grantId: "grant-task-2",
            toolPattern: "fs.write",
            decision: "allow",
            scope: "task",
            scopeRef: "task-2",
            grantType: "persistent",
            createdBy: "test",
            createdAt: new Date().toISOString(),
          },
        ];
      }
      return [];
    });
    vi.mocked(storage.toolAccessDecisions.countToolCallsInLastHourInScope).mockImplementation((input) => {
      expect(input.scope).toBe("task");
      expect(input.taskId).toBe("task-2");
      return 0;
    });
    const engine = new ToolPolicyEngine(policyConfig, storage);
    const evaluation = engine.evaluateAccess({
      toolName: "fs.write",
      args: { path: "./workspace/output.txt", content: "hello" },
      agentId: "agent",
      sessionId: "session-1",
      taskId: "task-2",
    });
    expect(evaluation.allowed).toBe(true);
    expect(evaluation.requiresApproval).toBe(true);
  });

  it("treats workspace-scoped grants as first mutation per workspace instead of global", () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockImplementation((scope, scopeRef) => {
      if (scope === "workspace" && scopeRef === "workspace-1") {
        return [
          {
            grantId: "grant-workspace-1",
            toolPattern: "fs.write",
            decision: "allow",
            scope: "workspace",
            scopeRef: "workspace-1",
            grantType: "persistent",
            createdBy: "test",
            createdAt: new Date().toISOString(),
          },
        ];
      }
      if (scope === "global" && scopeRef === "global") {
        return [
          {
            grantId: "grant-global",
            toolPattern: "fs.write",
            decision: "allow",
            scope: "global",
            scopeRef: "global",
            grantType: "persistent",
            createdBy: "test",
            createdAt: new Date().toISOString(),
          },
        ];
      }
      return [];
    });
    vi.mocked(storage.toolAccessDecisions.countToolCallsInLastHourInScope).mockImplementation((input) => {
      expect(input.scope).toBe("workspace");
      expect(input.workspaceId).toBe("workspace-1");
      return 0;
    });

    const engine = new ToolPolicyEngine(policyConfig, storage);
    const evaluation = engine.evaluateAccess({
      toolName: "fs.write",
      args: { path: "./workspace/output.txt", content: "hello" },
      agentId: "agent",
      sessionId: "session-1",
      workspaceId: "workspace-1",
    });

    expect(evaluation.allowed).toBe(true);
    expect(evaluation.requiresApproval).toBe(true);
  });

  it("lets matching denies beat allows across scopes", () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockImplementation((scope, scopeRef) => {
      if (scope === "session" && scopeRef === "session-1") {
        return [
          {
            grantId: "grant-session-allow",
            toolPattern: "shell.exec",
            decision: "allow",
            scope,
            scopeRef,
            grantType: "persistent",
            createdBy: "test",
            createdAt: new Date().toISOString(),
          },
        ];
      }
      if (scope === "task" && scopeRef === "task-1") {
        return [
          {
            grantId: "grant-task-deny",
            toolPattern: "shell.exec",
            decision: "deny",
            scope,
            scopeRef,
            grantType: "persistent",
            createdBy: "test",
            createdAt: new Date().toISOString(),
          },
        ];
      }
      return [];
    });

    const engine = new ToolPolicyEngine(policyConfig, storage);
    const evaluation = engine.evaluateAccess({
      toolName: "shell.exec",
      args: { command: "echo hello" },
      agentId: "agent",
      sessionId: "session-1",
      taskId: "task-1",
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toContain("grant_deny");
  });

  it("blocks privileged execution when the request trust level is untrusted_external", () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(policyConfig, storage);

    const evaluation = engine.evaluateAccess({
      toolName: "shell.exec",
      args: { command: "echo hello" },
      agentId: "agent",
      sessionId: "session-1",
      trustLevel: "untrusted_external",
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toContain("untrusted_source_privileged_tool_block");
  });

  it("blocks writes into read-only reference roots even when granted", () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockReturnValue([
      {
        grantId: "grant-reference-write",
        toolPattern: "fs.write",
        decision: "allow",
        scope: "session",
        scopeRef: "session-1",
        grantType: "persistent",
        constraints: {
          referenceRoots: [
            {
              label: "claude-code-reference",
              rootPath: "F:\\code\\claude-code",
              access: "read_only",
            },
          ],
        },
        createdBy: "test",
        createdAt: new Date().toISOString(),
      },
    ]);

    const engine = new ToolPolicyEngine(policyConfig, storage);
    const evaluation = engine.evaluateAccess({
      toolName: "fs.write",
      args: { path: "F:/code/claude-code/README.md", content: "mutate" },
      agentId: "agent",
      sessionId: "session-1",
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toContain("grant_constraints_block");
  });

  it("blocks scoped grants when mutation, rate, host, and path constraints fail", () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          approvalMode: "bypass",
        },
        sandbox: {
          ...policyConfig.sandbox,
          writeJailRoots: ["./workspace"],
          networkAllowlist: ["example.com", "blocked.example"],
        },
      },
      storage,
    );
    const grantBase = {
      grantId: "grant-constraints",
      toolPattern: "fs.write",
      decision: "allow",
      scope: "session",
      scopeRef: "session-1",
      grantType: "persistent",
      createdBy: "test",
      createdAt: new Date().toISOString(),
    } as const;

    vi.mocked(storage.toolGrants.list).mockReturnValue([{ ...grantBase, constraints: { mutationAllowed: false } }]);
    expect(
      engine.evaluateAccess({
        toolName: "fs.write",
        args: { path: "./workspace/out.txt", content: "x" },
        agentId: "agent",
        sessionId: "session-1",
      }).reasonCodes,
    ).toEqual(["grant_constraints_block"]);

    vi.mocked(storage.toolGrants.list).mockReturnValue([{ ...grantBase, constraints: { maxCallsPerHour: 1 } }]);
    vi.mocked(storage.toolAccessDecisions.countToolCallsInLastHourInScope).mockReturnValueOnce(1);
    expect(
      engine.evaluateAccess({
        toolName: "fs.write",
        args: { path: "./workspace/out.txt", content: "x" },
        agentId: "agent",
        sessionId: "session-1",
      }).reasonCodes,
    ).toEqual(["grant_constraints_block"]);

    vi.mocked(storage.toolGrants.list).mockReturnValue([{ ...grantBase, constraints: { maxWritesPerHour: 1 } }]);
    vi.mocked(storage.toolAccessDecisions.countWritesInLastHourInScope).mockReturnValueOnce(1);
    expect(
      engine.evaluateAccess({
        toolName: "fs.write",
        args: { path: "./workspace/out.txt", content: "x" },
        agentId: "agent",
        sessionId: "session-1",
      }).reasonCodes,
    ).toEqual(["grant_constraints_block"]);

    vi.mocked(storage.toolGrants.list).mockReturnValue([
      { ...grantBase, constraints: { allowedPaths: ["./workspace/allowed"] } },
    ]);
    expect(
      engine.evaluateAccess({
        toolName: "fs.write",
        args: { path: "./workspace/blocked/out.txt", content: "x" },
        agentId: "agent",
        sessionId: "session-1",
      }).reasonCodes,
    ).toEqual(["grant_constraints_block"]);

    vi.mocked(storage.toolGrants.list).mockReturnValue([
      {
        grantId: "grant-hosts",
        toolPattern: "http.get",
        decision: "allow",
        scope: "session",
        scopeRef: "session-1",
        grantType: "persistent",
        constraints: { allowedHosts: ["*.example.com"] },
        createdBy: "test",
        createdAt: new Date().toISOString(),
      },
    ]);
    expect(
      engine.evaluateAccess({
        toolName: "http.get",
        args: { url: "https://blocked.example/path" },
        agentId: "agent",
        sessionId: "session-1",
      }).reasonCodes,
    ).toEqual(["grant_constraints_block"]);
  });

  it("returns internal tool envelopes for executed requests", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(policyConfig, storage);

    const result = await engine.invoke({
      toolName: "session.status",
      args: {},
      agentId: "agent",
      sessionId: "session-1",
      trustLevel: "trusted_workspace",
    });

    expect(result.outcome).toBe("executed");
    expect(result.internalCall).toMatchObject({
      version: "v1",
      toolName: "session.status",
      trustLevel: "trusted_workspace",
    });
    expect(result.internalResult).toMatchObject({
      version: "v1",
      toolName: "session.status",
      outcome: "executed",
    });
    expect(result.audit).toMatchObject({
      auditEventId: result.auditEventId,
      toolName: "session.status",
      outcome: "executed",
    });
  });

  it("redacts secret-looking tool arguments before persisting audit records", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(policyConfig, storage);

    await (
      engine as unknown as {
        recordInvocation: (
          auditEventId: string,
          request: {
            toolName: string;
            args: Record<string, unknown>;
            agentId: string;
            sessionId: string;
            taskId?: string;
          },
          outcome: "executed" | "approval_required" | "blocked",
          policyReason: string,
        ) => Promise<void>;
      }
    ).recordInvocation(
      "audit-1",
      {
        toolName: "session.status",
        args: {
          command:
            "DATABASE_URL=mongodb://example.com:27017/myapp API_KEY=sk_test_1234567890abcdefghijklmnop NODE_ENV=production",
        },
        agentId: "agent",
        sessionId: "session-1",
      },
      "executed",
      "allowed",
    );

    expect(vi.mocked(storage.audit.append)).toHaveBeenCalledWith(
      "tool_invocations",
      expect.objectContaining({
        args: {
          command: expect.stringContaining("[REDACTED]"),
        },
      }),
    );
    expect(JSON.stringify(vi.mocked(storage.audit.append).mock.calls)).not.toContain(
      "sk_test_1234567890abcdefghijklmnop",
    );
  });
});

function createPendingApprovalAction(input: {
  approvalId: string;
  request: Record<string, unknown>;
  createdAt?: string;
  expiresAt?: string;
}): PendingApprovalAction {
  return {
    approvalId: input.approvalId,
    actionType: "tool.invoke",
    request: input.request,
    createdAt: input.createdAt ?? "2026-03-21T00:00:00.000Z",
    expiresAt: input.expiresAt,
    resolutionStatus: "pending",
  };
}
