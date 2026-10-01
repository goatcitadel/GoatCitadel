import { expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ request: vi.fn(async () => ({})) }));
vi.mock("./client-core.js", () => ({ request: api.request }));
import { updateReviewedCapabilities, resetReviewedCapabilities } from "./capabilities-scope.js";

it("binds reviewed commands to distinct paths, scope, family and opaque revision", async () => {
  const input = { resourceType: "skill" as const, expectedRevision: "a".repeat(64), assignments: [{ resourceRef: "skill", enabled: false }] };
  await updateReviewedCapabilities("citadel", "one/two", input);
  await resetReviewedCapabilities("workspace", "ws/one", "mcp_server", input.expectedRevision);
  expect(api.request.mock.calls).toEqual([
    ["/api/v1/citadels/one%2Ftwo/capabilities/reviewed", { method: "PATCH", body: JSON.stringify(input) }],
    ["/api/v1/workspaces/ws%2Fone/capabilities/reviewed", { method: "DELETE", body: JSON.stringify({ resourceType: "mcp_server", expectedRevision: input.expectedRevision }) }],
  ]);
});
