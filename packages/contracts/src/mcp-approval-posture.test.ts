import { describe, expect, it } from "vitest";
import {
  assertMcpServerConnectionConfiguration,
  capMcpApprovalPosture,
  mcpCallAsksFirst,
  type McpApprovalPosture,
  type McpServerConnectionConfiguration,
  type McpToolRecord,
} from "./mcp.js";

type Annotations = McpToolRecord["annotations"];

describe("mcpCallAsksFirst", () => {
  const cases: Array<{
    name: string;
    posture: McpApprovalPosture | undefined;
    annotations: Annotations;
    asks: boolean;
  }> = [
    {
      name: "an unset setting asks, as every MCP call did before",
      posture: undefined,
      annotations: undefined,
      asks: true,
    },
    {
      name: "an unset setting asks even for a read-only tool",
      posture: undefined,
      annotations: { readOnlyHint: true },
      asks: true,
    },
    {
      name: "everything_asks asks for a read-only tool",
      posture: "everything_asks",
      annotations: { readOnlyHint: true },
      asks: true,
    },
    {
      name: "reads_free lets a read-only tool through",
      posture: "reads_free",
      annotations: { readOnlyHint: true },
      asks: false,
    },
    {
      name: "reads_free still asks for a non-destructive tool that is not marked read-only",
      posture: "reads_free",
      annotations: { destructiveHint: false },
      asks: true,
    },
    {
      name: "reads_free still asks when readOnlyHint is false",
      posture: "reads_free",
      annotations: { readOnlyHint: false },
      asks: true,
    },
    { name: "reads_free asks for a tool with no labels", posture: "reads_free", annotations: {}, asks: true },
    {
      name: "reads_free asks for a tool with no annotations at all",
      posture: "reads_free",
      annotations: undefined,
      asks: true,
    },
    {
      name: "nothing_asks lets a non-destructive tool through",
      posture: "nothing_asks",
      annotations: { destructiveHint: false },
      asks: false,
    },
    { name: "nothing_asks still asks for a tool with no labels", posture: "nothing_asks", annotations: {}, asks: true },
    {
      name: "nothing_asks still asks for a tool with no annotations at all",
      posture: "nothing_asks",
      annotations: undefined,
      asks: true,
    },
    {
      name: "nothing_asks still asks for a destructive tool",
      posture: "nothing_asks",
      annotations: { destructiveHint: true },
      asks: true,
    },
    {
      name: "nothing_asks lets a read-only tool through",
      posture: "nothing_asks",
      annotations: { readOnlyHint: true },
      asks: false,
    },
    {
      name: "nothing_asks asks for a tool marked destructive",
      posture: "nothing_asks",
      annotations: { readOnlyHint: false, destructiveHint: true },
      asks: true,
    },
    {
      name: "reads_free asks for a tool marked both read-only and destructive",
      posture: "reads_free",
      annotations: { readOnlyHint: true, destructiveHint: true },
      asks: true,
    },
    {
      name: "nothing_asks asks for a tool marked both read-only and destructive",
      posture: "nothing_asks",
      annotations: { readOnlyHint: true, destructiveHint: true },
      asks: true,
    },
  ];

  it.each(cases)("$name", ({ posture, annotations, asks }) => {
    expect(mcpCallAsksFirst(posture, annotations)).toBe(asks);
  });

  it("treats an unrecognised setting as asking, so a damaged record never loosens approvals", () => {
    expect(mcpCallAsksFirst("sometimes" as McpApprovalPosture, { readOnlyHint: true })).toBe(true);
  });
});

describe("capMcpApprovalPosture", () => {
  it.each([
    [undefined, false, undefined],
    [undefined, true, undefined],
    ["everything_asks", true, "everything_asks"],
    ["reads_free", true, "reads_free"],
    ["nothing_asks", false, "nothing_asks"],
    ["nothing_asks", true, "reads_free"],
  ] as const)("keeps %s for a server where moving money is %s as %s", (posture, movesMoney, capped) => {
    expect(capMcpApprovalPosture(posture, movesMoney)).toBe(capped);
  });

  it("never lets a money-moving server's non-destructive change run on its own", () => {
    const capped = capMcpApprovalPosture("nothing_asks", true);
    expect(mcpCallAsksFirst(capped, { destructiveHint: false })).toBe(true);
    expect(mcpCallAsksFirst(capped, { readOnlyHint: true })).toBe(false);
  });
});

describe("requester-scoped server policy and approvalPosture", () => {
  function requesterConfiguration(
    policy: McpServerConnectionConfiguration["policy"],
  ): McpServerConnectionConfiguration {
    return {
      transport: "http",
      connectionMode: "requester_scoped",
      configurationRevision: 7,
      authType: "none",
      policy,
      requesterResolution: {
        resolverId: "gateway.tenant-mcp",
        resolverVersion: "1.2.3",
        configGeneration: 4,
        transportPolicy: {
          allowedSchemes: ["https"],
          allowedHosts: ["mcp.example.test"],
          allowedPorts: [443],
          allowedHeaderNames: ["authorization", "x-tenant"],
        },
      },
    };
  }

  it("accepts approvalPosture in a requester-scoped server policy", () => {
    expect(() =>
      assertMcpServerConnectionConfiguration(requesterConfiguration({ approvalPosture: "reads_free" })),
    ).not.toThrow();
  });

  it("still rejects unknown policy fields on a requester-scoped server", () => {
    expect(() =>
      assertMcpServerConnectionConfiguration(
        requesterConfiguration({ approvalMode: "reads_free" } as unknown as McpServerConnectionConfiguration["policy"]),
      ),
    ).toThrow(/unsupported fields/);
  });
});
