import { describe, expect, it, vi } from "vitest";
import { ValidationError, type ChatProjectRecord, type WorkspaceRecord } from "@goatcitadel/contracts";
import {
  resolveEffectiveRuntimeScopeFromStorage,
  type EffectiveRuntimeScopeDependencies,
} from "./effective-runtime-scope-service.js";

function createDeps(input: {
  workspaces?: Record<string, Partial<WorkspaceRecord>>;
  projects?: Record<string, Partial<ChatProjectRecord>>;
  sessions?: Record<string, { workspaceId?: string }>;
}): EffectiveRuntimeScopeDependencies {
  return {
    storage: {
      workspaces: {
        find: vi.fn((workspaceId: string) => input.workspaces?.[workspaceId] as WorkspaceRecord | undefined),
      },
      chatProjects: {
        get: vi.fn((projectId: string) => input.projects?.[projectId] as ChatProjectRecord),
      },
      chatSessionMeta: {
        ensure: vi.fn((sessionId: string) => input.sessions?.[sessionId] ?? { workspaceId: "default" }),
      },
      chatSessionProjects: {},
    },
    normalizeWorkspaceId: (workspaceId?: string) => {
      const normalized = workspaceId?.trim();
      return normalized || "default";
    },
  } as unknown as EffectiveRuntimeScopeDependencies;
}

describe("resolveEffectiveRuntimeScopeFromStorage", () => {
  it("derives Citadel scope from an explicit workspace", () => {
    const deps = createDeps({
      workspaces: {
        engineering: { workspaceId: "engineering", citadelId: "company" },
      },
    });

    expect(resolveEffectiveRuntimeScopeFromStorage(deps, { workspaceId: "engineering", mode: "code" })).toEqual({
      citadelId: "company",
      workspaceId: "engineering",
      mode: "code",
    });
  });

  it("derives workspace and Citadel scope from a project", () => {
    const deps = createDeps({
      workspaces: {
        engineering: { workspaceId: "engineering", citadelId: "company" },
      },
      projects: {
        "project-1": { projectId: "project-1", workspaceId: "engineering" },
      },
    });

    expect(resolveEffectiveRuntimeScopeFromStorage(deps, { projectId: "project-1" })).toEqual({
      citadelId: "company",
      workspaceId: "engineering",
      projectId: "project-1",
    });
  });

  it("derives workspace and Citadel scope from a session", () => {
    const deps = createDeps({
      workspaces: {
        finance: { workspaceId: "finance", citadelId: "company" },
      },
      sessions: {
        "session-1": { workspaceId: "finance" },
      },
    });

    expect(resolveEffectiveRuntimeScopeFromStorage(deps, { sessionId: "session-1" })).toEqual({
      citadelId: "company",
      workspaceId: "finance",
      sessionId: "session-1",
    });
  });

  it("rejects an explicit Citadel that weakens the workspace boundary", () => {
    const deps = createDeps({
      workspaces: {
        finance: { workspaceId: "finance", citadelId: "company" },
      },
    });

    expect(() =>
      resolveEffectiveRuntimeScopeFromStorage(deps, { citadelId: "personal", workspaceId: "finance" }),
    ).toThrow(ValidationError);
    expect(() =>
      resolveEffectiveRuntimeScopeFromStorage(deps, { citadelId: "personal", workspaceId: "finance" }),
    ).toThrow(/belongs to citadel company/);
  });

  it("rejects a project that belongs to a different workspace", () => {
    const deps = createDeps({
      workspaces: {
        finance: { workspaceId: "finance", citadelId: "company" },
      },
      projects: {
        "project-1": { projectId: "project-1", workspaceId: "engineering" },
      },
    });

    expect(() =>
      resolveEffectiveRuntimeScopeFromStorage(deps, { workspaceId: "finance", projectId: "project-1" }),
    ).toThrow(ValidationError);
    expect(() =>
      resolveEffectiveRuntimeScopeFromStorage(deps, { workspaceId: "finance", projectId: "project-1" }),
    ).toThrow(/belongs to workspace engineering/);
  });
});
