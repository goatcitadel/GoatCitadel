import { expect, it } from "vitest";
import type { McpReviewedOAuthStartResponse, McpServerRecord } from "@goatcitadel/contracts";
import { describeAuthorizeHost, describeRequestedScopes, validMcpOAuthStart } from "./mcp-oauth-binding";

const state = "11111111-1111-4111-8111-111111111111";
const before: McpServerRecord = {
  serverId: "vendor",
  revision: "a".repeat(64),
  connectionRevision: "b".repeat(64),
  configurationBindingId: "11111111-2222-4333-8444-555555555555",
  label: "Vendor",
  transport: "http",
  url: "https://mcp.vendor.example/mcp",
  authType: "oauth2",
  oauth: { metadataDiscovery: true },
  enabled: false,
  status: "disconnected",
  category: "automation",
  trustTier: "restricted",
  costTier: "mixed",
  policy: { requireFirstToolApproval: true, redactionMode: "strict", allowedToolPatterns: [], blockedToolPatterns: [] },
  createdAt: "2026-10-24T00:00:00.000Z",
  updatedAt: "2026-10-24T00:00:00.000Z",
};
function flowFor(authorize: (url: URL) => void, issuer: string | null = "https://auth.vendor.example") {
  const url = new URL("https://auth.vendor.example/oauth/authorize?tenant=acme");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", "http://127.0.0.1:8787/api/v1/mcp/oauth/callback");
  url.searchParams.set("client_id", "registered");
  url.searchParams.set("scope", "read write");
  url.searchParams.set("code_challenge", "challenge");
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", "https://mcp.vendor.example/mcp");
  authorize(url);
  return {
    authorizeUrl: url.toString(),
    state,
    review: {
      version: 1,
      reviewed: { expectedRevision: before.revision!, expectedConnectionRevision: before.connectionRevision! },
      server: {
        ...before,
        connectionRevision: "c".repeat(64),
        authState: { authType: "oauth2", readiness: "needs_auth", ...(issuer ? { authorizationIssuer: issuer } : {}) },
      },
    },
  } as McpReviewedOAuthStartResponse;
}

it("accepts a discovered endpoint that carries its own query, and checks every Gateway parameter", () => {
  expect(
    validMcpOAuthStart(
      before,
      flowFor(() => undefined),
    ),
  ).toBe(true);
  expect(
    validMcpOAuthStart(
      before,
      flowFor((url) => url.searchParams.set("state", "other")),
    ),
  ).toBe(false);
  expect(
    validMcpOAuthStart(
      before,
      flowFor((url) => url.searchParams.set("redirect_uri", "https://evil.example/cb")),
    ),
  ).toBe(false);
  expect(
    validMcpOAuthStart(
      before,
      flowFor((url) => url.searchParams.set("code_challenge_method", "plain")),
    ),
  ).toBe(false);
  expect(
    validMcpOAuthStart(
      before,
      flowFor((url) => url.searchParams.append("state", state)),
    ),
  ).toBe(false);
  expect(
    validMcpOAuthStart(
      before,
      flowFor((url) => url.searchParams.set("resource", "https://other.example/mcp")),
    ),
  ).toBe(false);
  expect(
    validMcpOAuthStart(
      before,
      flowFor((url) => (url.protocol = "http:")),
    ),
  ).toBe(false);
  expect(
    validMcpOAuthStart(
      before,
      flowFor(() => undefined, null),
    ),
  ).toBe(false);
});

it("describes where the sign-in link goes and the access it asks for", () => {
  const { authorizeUrl } = flowFor(() => undefined);
  expect(describeAuthorizeHost(authorizeUrl)).toBe("https://auth.vendor.example");
  expect(describeRequestedScopes(authorizeUrl)).toBe("read, write");
  expect(describeRequestedScopes("https://auth.vendor.example/authorize")).toBe("The provider's default access");
});
