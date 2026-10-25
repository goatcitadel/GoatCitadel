import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteAsyncStorage, Storage, type AsyncStorage } from "@goatcitadel/storage";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import { ToolPolicyEngine } from "./engine.js";
import { pinFirecrawlEndpoint, type FirecrawlOperatorEndpoint } from "./firecrawl-endpoint.js";
import { resetFirecrawlReachabilityForTests } from "./firecrawl-reachability.js";

const OPERATOR: FirecrawlOperatorEndpoint = {
  baseUrl: "https://firecrawl.operator.example",
  apiKeyEnv: "GOATCITADEL_FIRECRAWL_API_KEY",
};
const ELSEWHERE = "https://elsewhere.example";
const BASE_URL_REFUSED = "firecrawlBaseUrl comes from the operator's Firecrawl settings";
const KEY_ENV_REFUSED = "firecrawlApiKeyEnv comes from the operator's Firecrawl settings";

const config: ToolPolicyConfig = {
  tools: { approvalMode: "bypass", allow: ["*"], deny: [] },
  agents: {},
  sandbox: {
    writeJailRoots: [],
    readOnlyRoots: [],
    // Both Firecrawl hosts are allowlisted, so only the operator pin can keep a call off the second one.
    networkAllowlist: ["example.com", "firecrawl.operator.example", "elsewhere.example"],
    riskyShellPatterns: [],
    requireApprovalForRiskyShell: true,
  },
};

/** One Firecrawl-backed call per tool, with the Firecrawl path each one posts to. */
const FIRECRAWL_CALLS: Array<{ toolName: string; args: Record<string, unknown>; path: string }> = [
  { toolName: "browser.search", args: { query: "goat facts", backend: "firecrawl" }, path: "/v2/search" },
  { toolName: "browser.navigate", args: { url: "https://example.com/page", backend: "firecrawl" }, path: "/v2/scrape" },
  {
    toolName: "browser.extract",
    args: { url: "https://example.com/page", selector: "main", backend: "firecrawl" },
    path: "/v2/scrape",
  },
  {
    toolName: "docs.ingest",
    args: { sourceType: "url", source: "https://example.com/page", namespace: "web", backend: "firecrawl" },
    path: "/v2/scrape",
  },
];

let storage: AsyncStorage;
let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "goat-firecrawl-endpoint-"));
  storage = createSqliteAsyncStorage(
    new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(directory, "transcripts"),
      auditDir: path.join(directory, "audit"),
    }),
  );
});
beforeEach(() => {
  // The environment names other endpoints and keys; only the operator endpoint may win.
  vi.stubEnv("FIRECRAWL_BASE_URL", ELSEWHERE);
  vi.stubEnv("GOATCITADEL_FIRECRAWL_API_KEY_ENV", "FIRECRAWL_API_KEY");
  vi.stubEnv("FIRECRAWL_API_KEY", "synthetic-other-key");
  vi.stubEnv("GOATCITADEL_FIRECRAWL_API_KEY", "synthetic-operator-key");
  vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "pseudo");
});
afterEach(() => {
  resetFirecrawlReachabilityForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await storage?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

/** `null` builds a host with no operator endpoint, like library callers and older tests. */
function engine(operator: FirecrawlOperatorEndpoint | null = OPERATOR): ToolPolicyEngine {
  return new ToolPolicyEngine(config, storage, undefined, operator ? { resolveFirecrawlEndpoint: () => operator } : {});
}

function request(toolName: string, args: Record<string, unknown>, dryRun: boolean): ToolInvokeRequest {
  return { toolName, args, agentId: "assistant", sessionId: "session-firecrawl", dryRun };
}

function stubFirecrawlFetch() {
  const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const target = input instanceof Request ? input.url : String(input);
    const body = target.endsWith("/v2/search")
      ? { success: true, data: [{ url: "https://example.com/goats", title: "Goats", description: "Goat facts." }] }
      : {
          success: true,
          data: {
            markdown: "# Goats\n\nGoat facts.",
            html: "<html><body><main><p>Goat facts.</p></main></body></html>",
            metadata: { title: "Goats", sourceURL: "https://example.com/page", statusCode: 200 },
          },
        };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("pinFirecrawlEndpoint", () => {
  it("leaves hosts without an operator endpoint on their argument and environment fallbacks", () => {
    expect(pinFirecrawlEndpoint({ firecrawlBaseUrl: ELSEWHERE }, undefined)).toBeUndefined();
  });

  it("accepts a repeated operator endpoint and fills the configured key variable", () => {
    expect(pinFirecrawlEndpoint({ firecrawlBaseUrl: "HTTPS://Firecrawl.Operator.Example/" }, OPERATOR)).toEqual({
      baseUrl: OPERATOR.baseUrl,
      apiKeyEnv: "GOATCITADEL_FIRECRAWL_API_KEY",
    });
    expect(pinFirecrawlEndpoint({ firecrawlBaseUrl: "  " }, { baseUrl: OPERATOR.baseUrl })).toEqual({
      baseUrl: OPERATOR.baseUrl,
      apiKeyEnv: "FIRECRAWL_API_KEY",
    });
  });

  it("refuses another endpoint, a non-text endpoint, or another key variable", () => {
    expect(() => pinFirecrawlEndpoint({ firecrawlBaseUrl: ELSEWHERE }, OPERATOR)).toThrow(BASE_URL_REFUSED);
    expect(() => pinFirecrawlEndpoint({ firecrawlBaseUrl: `${OPERATOR.baseUrl}/proxy` }, OPERATOR)).toThrow(
      BASE_URL_REFUSED,
    );
    expect(() => pinFirecrawlEndpoint({ firecrawlBaseUrl: { href: OPERATOR.baseUrl } }, OPERATOR)).toThrow(
      BASE_URL_REFUSED,
    );
    expect(() => pinFirecrawlEndpoint({ firecrawlApiKeyEnv: "FIRECRAWL_API_KEY" }, OPERATOR)).toThrow(KEY_ENV_REFUSED);
    expect(() => pinFirecrawlEndpoint({ firecrawlApiKeyEnv: "OPENAI_API_KEY" }, OPERATOR)).toThrow(KEY_ENV_REFUSED);
  });
});

describe("operator-owned Firecrawl endpoint in the policy engine", () => {
  it.each(FIRECRAWL_CALLS)("blocks $toolName when the call names another Firecrawl endpoint", async (call) => {
    const fetchMock = stubFirecrawlFetch();
    const result = await engine().invoke(request(call.toolName, { ...call.args, firecrawlBaseUrl: ELSEWHERE }, false));

    expect(result.outcome).toBe("blocked");
    expect(result.policyReason).toContain(BASE_URL_REFUSED);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(FIRECRAWL_CALLS)("blocks $toolName when the call names another key variable", async (call) => {
    const result = await engine().invoke(
      request(call.toolName, { ...call.args, firecrawlApiKeyEnv: "FIRECRAWL_API_KEY" }, true),
    );

    expect(result.outcome).toBe("blocked");
    expect(result.policyReason).toContain(KEY_ENV_REFUSED);
  });

  it.each(FIRECRAWL_CALLS)("sends $toolName to the operator endpoint with the operator key", async (call) => {
    const fetchMock = stubFirecrawlFetch();
    const repeated = await engine().invoke(
      request(call.toolName, { ...call.args, firecrawlBaseUrl: `${OPERATOR.baseUrl}/` }, true),
    );
    expect(repeated.outcome).not.toBe("blocked");

    const result = await engine().invoke(
      request(call.toolName, { ...call.args, firecrawlFallbackToNative: false }, false),
    );

    expect(result.outcome).toBe("executed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target, init] = fetchMock.mock.calls[0]!;
    expect(String(target)).toBe(`${OPERATOR.baseUrl}${call.path}`);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-operator-key");
  });

  it("checks the operator endpoint, not the environment, against the allowlist", async () => {
    const result = await engine({ baseUrl: "https://unlisted.example" }).invoke(
      request("browser.navigate", { url: "https://example.com/page", backend: "firecrawl" }, true),
    );

    expect(result.outcome).toBe("blocked");
    expect(result.policyReason).toContain("unlisted.example");
  });

  it("applies the pin to a mixed-case backend, which the browser executor treats as Firecrawl", async () => {
    const result = await engine().invoke(
      request("browser.search", { query: "goat facts", backend: " FireCrawl ", firecrawlBaseUrl: ELSEWHERE }, true),
    );

    expect(result.outcome).toBe("blocked");
    expect(result.policyReason).toContain(BASE_URL_REFUSED);
  });

  it("keeps the argument fallback on hosts that supply no operator endpoint", async () => {
    const result = await engine(null).invoke(
      request(
        "browser.navigate",
        { url: "https://example.com/page", backend: "firecrawl", firecrawlBaseUrl: ELSEWHERE },
        true,
      ),
    );

    expect(result.outcome).not.toBe("blocked");
  });
});
