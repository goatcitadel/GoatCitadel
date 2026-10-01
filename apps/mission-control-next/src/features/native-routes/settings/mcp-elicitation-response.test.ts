import { beforeEach, expect, it, vi } from "vitest";
import { elicitationFixture, respondedFixture } from "./mcp-elicitation.test-support";
import { mcpElicitationFields, mcpResponseContent } from "./mcp-elicitation-fields";
import { __resetMcpResponsesForTests, commitMcpElicitationResponse } from "./mcp-elicitation-response";
const api = vi.hoisted(() => ({ fetchMcpElicitations: vi.fn(), respondMcpElicitation: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
let current = elicitationFixture();
beforeEach(() => {
  vi.resetAllMocks();
  __resetMcpResponsesForTests();
  current = elicitationFixture();
  api.fetchMcpElicitations.mockImplementation(async () => ({ items: [structuredClone(current)] }));
  api.respondMcpElicitation.mockImplementation(async (_id, input) => {
    current = respondedFixture(current, input.action, input.content);
    return structuredClone(current);
  });
});
const commit = (patch: Partial<Parameters<typeof commitMcpElicitationResponse>[0]> = {}) =>
  commitMcpElicitationResponse({
    request: elicitationFixture(),
    action: "accept",
    values: { name: "Visible", count: "2", enabled: "false" },
    workspaceId: "workspace",
    isCurrent: () => true,
    ...patch,
  });
it("submits the exact original owner and typed fields, then verifies the terminal owner record", async () => {
  expect((await commit())?.status).toBe("accepted");
  expect(api.respondMcpElicitation).toHaveBeenCalledExactlyOnceWith("request-one", {
    action: "accept",
    content: { name: "Visible", count: 2, enabled: false },
    owner: elicitationFixture().owner,
  });
  expect(api.fetchMcpElicitations).toHaveBeenCalledTimes(2);
  await commit();
  expect(api.respondMcpElicitation).toHaveBeenCalledTimes(1);
});
it.each(["decline", "cancel"] as const)("records %s without content even for an unsupported schema", async (action) => {
  current.requestedSchema.value = { type: "array" };
  current.protocol.requestedSchema = current.requestedSchema.value;
  expect((await commit({ request: structuredClone(current), action }))?.response?.content).toBeUndefined();
});
it.each(["schema", "owner", "resolved", "duplicate", "missing"])(
  "withholds a changed, foreign or ambiguous fresh owner: %s",
  async (kind) => {
    if (kind === "schema") current.requestedSchema.value.title = "Changed";
    if (kind === "owner") current.owner.workspaceId = "foreign";
    if (kind === "resolved") current = respondedFixture(current, "decline");
    if (kind === "duplicate") api.fetchMcpElicitations.mockResolvedValue({ items: [current, current] });
    if (kind === "missing") api.fetchMcpElicitations.mockResolvedValue({ items: [] });
    expect(await commit()).toBeUndefined();
    expect(api.respondMcpElicitation).not.toHaveBeenCalled();
  },
);
it("rejects foreign scope before reads and cancels a changed view after preflight", async () => {
  await commit({ workspaceId: "foreign" });
  expect(api.fetchMcpElicitations).not.toHaveBeenCalled();
  let live = true;
  api.fetchMcpElicitations.mockImplementation(async () => {
    live = false;
    return { items: [current] };
  });
  await commit({ isCurrent: () => live });
  expect(api.respondMcpElicitation).not.toHaveBeenCalled();
});
it.each(["lost", "wrong-receipt", "wrong-readback"])(
  "locks a post-dispatch %s outcome across another workspace attempt",
  async (kind) => {
    if (kind === "lost") api.respondMcpElicitation.mockRejectedValue(new Error("lost"));
    if (kind === "wrong-receipt")
      api.respondMcpElicitation.mockImplementation(async () =>
        respondedFixture({ ...current, elicitationId: "foreign" }, "accept", { name: "Visible" }),
      );
    if (kind === "wrong-readback")
      api.fetchMcpElicitations.mockResolvedValueOnce({ items: [current] }).mockResolvedValue({ items: [] });
    expect(await commit()).toBeUndefined();
    await commit({ workspaceId: "other" });
    await commit();
    expect(api.respondMcpElicitation).toHaveBeenCalledTimes(1);
  },
);
it("retains pending admission during overlapping clicks", async () => {
  let resolve!: (result: { items: (typeof current)[] }) => void;
  api.fetchMcpElicitations.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const first = commit();
  await commit();
  expect(api.fetchMcpElicitations).toHaveBeenCalledTimes(1);
  resolve({ items: [current] });
  await first;
  expect(api.respondMcpElicitation).toHaveBeenCalledTimes(1);
});
it("validates required, integer, range, enum and bounded object fields", () => {
  const request = elicitationFixture();
  expect(mcpElicitationFields(request).fields).toHaveLength(3);
  const cases: Array<Record<string, string>> = [
    {},
    { name: "A" },
    { name: "Valid", count: "2.5" },
    { name: "Valid", count: "9" },
    { name: "Valid", count: "  " },
    { name: "Valid", count: "0x2" },
    { name: "Valid", enabled: "yes" },
    { name: "Valid", unknown: "extra" },
  ];
  for (const values of cases) expect(() => mcpResponseContent(request, values)).toThrow();
});
it.each([
  { type: "string", format: "password" },
  { type: "array" },
  { type: "string", pattern: ".*" },
  { type: "string", enum: [1] },
  { type: "string", enum: [""] },
  { type: "number", minimum: "bad" },
  { type: "number", minimum: 5, maximum: 1 },
])("withholds unsupported property semantics: %o", (property) => {
  const request = elicitationFixture();
  request.requestedSchema.value.properties = { field: property };
  request.requestedSchema.value.required = [];
  expect(mcpElicitationFields(request).unavailable).toBeTruthy();
});
it("withholds sensitive, redacted, truncated and contradictory protocol schemas", () => {
  for (const kind of ["sensitive", "redacted", "truncated", "protocol", "message"]) {
    const request = elicitationFixture();
    if (kind === "sensitive") request.requestedSchema.value.properties = { password: { type: "string" } };
    if (kind === "redacted") request.requestedSchema.redactedSecretCount = 1;
    if (kind === "truncated") request.prompt.truncated = true;
    if (kind === "protocol") request.protocol.requestedSchema = {};
    if (kind === "message") request.protocol.message = "Different request";
    expect(mcpElicitationFields(request).unavailable).toBeTruthy();
  }
});
