import { expect, it, vi } from "vitest";
const request = vi.hoisted(() => vi.fn(async () => ({ state: "unverified" })));
vi.mock("./client-core.js", () => ({ request }));
import { fetchMcpServerTestEvidence } from "./mcp.js";
it("encodes only server/workspace and always re-reads the canonical tested projection", async () => {
  await fetchMcpServerTestEvidence("server/one", "workspace two");
  expect(request).toHaveBeenCalledWith("/api/v1/mcp/servers/server%2Fone/test-evidence?workspaceId=workspace+two", {
    cache: "no-store",
  });
});
