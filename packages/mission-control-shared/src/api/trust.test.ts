import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrustPolicySnapshot } from "./trust";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  public get length(): number {
    return this.values.size;
  }

  public clear(): void {
    this.values.clear();
  }

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  public removeItem(key: string): void {
    this.values.delete(key);
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function installMockWindow(): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location: {
        protocol: "http:",
        hostname: "localhost",
        pathname: "/settings",
        search: "",
        hash: "",
      },
      localStorage: new MemoryStorage(),
      sessionStorage: new MemoryStorage(),
    },
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("trust API", () => {
  beforeEach(() => {
    vi.resetModules();
    installMockWindow();
    vi.stubGlobal("crypto", {
      randomUUID: () => "test-uuid",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("fetches the read-only trust policy snapshot projection", async () => {
    const snapshot = {
      generatedAt: "2026-05-30T00:00:00.000Z",
      readOnly: true,
      mutationSemantics: "none",
      enforcementSources: ["tools.permissionProfiles", "capabilities.catalog", "mcp.servers"],
      sources: [
        { key: "permissionProfiles", owner: "tools.permissionProfiles", status: "available", itemCount: 1 },
        { key: "mcpServers", owner: "mcp.servers", status: "available", itemCount: 1 },
        { key: "addons.installed", owner: "addons.installed", status: "unavailable", itemCount: 0 },
      ],
      permissionProfiles: [
        {
          profileId: "profile-1",
          label: "Careful Code",
          builtin: false,
          status: "active",
          posture: "callable",
          approvalMode: "approve_risky",
          source: "tools.permissionProfiles",
        },
      ],
      toolGrants: [],
      localOperatorOverrides: [],
      capabilities: {
        inspectable: [],
        callable: [
          {
            capabilityId: "cap-callable",
            kind: "tool",
            category: "built_in",
            title: "Read files",
            callable: true,
            posture: "callable",
            source: "capabilities.catalog",
          },
        ],
      },
      mcpServers: [
        {
          serverId: "mcp-1",
          label: "Quarantined Browser",
          enabled: true,
          status: "connected",
          trustTier: "quarantined",
          posture: "quarantined",
          source: "mcp.servers",
          tools: [{ toolName: "browser.navigate", enabled: true, posture: "quarantined", source: "mcp.tools" }],
        },
      ],
      skills: [],
      addons: [],
      lastUseEvidence: [],
    };
    const fetchMock = vi.fn(async () => jsonResponse(snapshot));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchTrustPolicySnapshot } = await import("./trust");

    const result = await fetchTrustPolicySnapshot();

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/v1/trust/policy-snapshot");
    expect(result.permissionProfiles[0]?.posture).toBe("callable");
    expect(result.capabilities.callable[0]?.posture).toBe("callable");
    expect(result.mcpServers[0]?.posture).toBe("quarantined");
    expect(result.sources.find((source) => source.key === "addons.installed")?.status).toBe("unavailable");
  });

  it("carries declared governance metadata and medium-trust posture through the snapshot", async () => {
    const snapshot: TrustPolicySnapshot = {
      generatedAt: "2026-06-22T00:00:00.000Z",
      readOnly: true,
      mutationSemantics: "none",
      enforcementSources: ["skills.lifecycle"],
      sources: [],
      permissionProfiles: [],
      toolGrants: [],
      localOperatorOverrides: [],
      capabilities: { inspectable: [], callable: [] },
      mcpServers: [],
      skills: [
        {
          skillId: "skill-gov",
          name: "Governed Skill",
          state: "enabled",
          callable: true,
          posture: "medium_trust_unverified",
          declaredMetadata: {
            requiredEnv: [{ name: "GOVERNED_KEY", secret: true }],
            stateDirs: [{ path: "state/cache", writeable: true }],
            dependencies: { capabilities: ["network"] },
          },
          bundleWarnings: ["Skill requires a secret env var: GOVERNED_KEY (needs an operator-provided secret)."],
          missingRequiredEnv: ["GOVERNED_KEY"],
          source: "skills.lifecycle",
        },
      ],
      addons: [],
      lastUseEvidence: [],
    };
    const fetchMock = vi.fn(async () => jsonResponse(snapshot));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchTrustPolicySnapshot } = await import("./trust");

    const result = await fetchTrustPolicySnapshot();
    const skill = result.skills[0];

    expect(skill?.posture).toBe("medium_trust_unverified");
    expect(skill?.declaredMetadata?.requiredEnv[0]?.name).toBe("GOVERNED_KEY");
    expect(skill?.declaredMetadata?.stateDirs[0]?.writeable).toBe(true);
    expect(skill?.bundleWarnings?.[0]).toContain("secret env var");
    expect(skill?.missingRequiredEnv).toEqual(["GOVERNED_KEY"]);
  });
});
