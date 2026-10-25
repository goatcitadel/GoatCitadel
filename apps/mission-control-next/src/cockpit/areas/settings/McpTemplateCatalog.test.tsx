// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { McpServerTemplateRecord } from "@goatcitadel/contracts";
import { describeMcpTemplateSignIn, filterMcpTemplates, McpTemplateCatalog } from "./McpTemplateCatalog";

const api = vi.hoisted(() => ({ fetchSettings: vi.fn(), patchSettings: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (original) => ({
  ...(await original<object>()),
  ...api,
}));

const base: McpServerTemplateRecord = {
  templateId: "notion",
  label: "Notion",
  description: "Pages and databases from your Notion workspace.",
  transport: "http",
  url: "https://mcp.notion.com/mcp",
  authType: "oauth2",
  oauth: { metadataDiscovery: true },
  category: "automation",
  trustTier: "restricted",
  costTier: "mixed",
  policy: { requireFirstToolApproval: true, redactionMode: "strict", allowedToolPatterns: [], blockedToolPatterns: [] },
  enabledByDefault: false,
  networkHosts: ["mcp.notion.com"],
  provenance: {
    catalog: "hermes-agent/optional-mcps",
    catalogLicense: "MIT",
    catalogCommit: "07ee800dc7",
    documentationUrl: "https://developers.notion.com/docs/mcp",
  },
};
const items: McpServerTemplateRecord[] = [
  base,
  {
    ...base,
    templateId: "sentry",
    label: "Sentry",
    description: "Errors and issues.",
    category: "development",
    url: "https://mcp.sentry.dev/mcp",
    networkHosts: ["mcp.sentry.dev"],
  },
  {
    ...base,
    templateId: "robinhood",
    label: "Robinhood",
    description: "Agentic trading.",
    url: "https://agent.robinhood.com/mcp/trading",
    networkHosts: ["agent.robinhood.com"],
    riskNotes: ["Places real brokerage trades."],
  },
];

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  api.fetchSettings.mockResolvedValue({ revision: 3, networkAllowlist: ["mcp.sentry.dev"] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(onUse = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <McpTemplateCatalog items={items} disabled={false} onUse={onUse} />
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() => expect(api.fetchSettings).toHaveBeenCalled());
  await act(async () => undefined);
  return onUse;
}
const buttons = () => [...container.querySelectorAll("button")];
const byText = (text: string) => buttons().find((button) => button.textContent === text);

it("describes sign-in in plain words and filters by search and category", () => {
  expect(describeMcpTemplateSignIn(base)).toBe("Sign in with the provider (automatic setup)");
  expect(describeMcpTemplateSignIn({ ...base, authType: "none" })).toBe("No sign-in");
  expect(filterMcpTemplates(items, "sent", "all").map((item) => item.templateId)).toEqual(["sentry"]);
  expect(filterMcpTemplates(items, "", "development").map((item) => item.templateId)).toEqual(["sentry"]);
  expect(filterMcpTemplates(items, "workspace", "automation").map((item) => item.templateId)).toEqual(["notion"]);
});

it("shows provenance, risk notes and allowlist state, and hands the chosen template back", async () => {
  const onUse = await render();
  await vi.waitFor(() => expect(container.textContent).toContain("mcp.sentry.dev (allowed)"));
  expect(container.textContent).toContain("Reviewed in the hermes-agent/optional-mcps catalog (MIT)");
  expect(container.textContent).toContain("Places real brokerage trades.");
  expect(container.textContent).toContain("mcp.sentry.dev (allowed)");
  expect(container.textContent).toContain("mcp.notion.com (not allowed yet)");
  expect(byText("Allow mcp.sentry.dev")).toBeUndefined();
  await act(async () => byText("Use Notion template")!.click());
  expect(onUse).toHaveBeenCalledWith(base);
});

it("adds only the missing hosts through the governed settings patch", async () => {
  api.patchSettings.mockResolvedValue({ changePlanReceipt: { status: "awaiting_approval" } });
  await render();
  await vi.waitFor(() => expect(byText("Allow mcp.notion.com")).toBeTruthy());
  await act(async () => byText("Allow mcp.notion.com")!.click());
  expect(api.patchSettings).toHaveBeenCalledWith({
    expectedRevision: 3,
    networkAllowlist: ["mcp.sentry.dev", "mcp.notion.com"],
  });
  expect(container.textContent).toContain(
    "Allowing mcp.notion.com needs approval. Approve the allowlist change in Inbox",
  );
});
