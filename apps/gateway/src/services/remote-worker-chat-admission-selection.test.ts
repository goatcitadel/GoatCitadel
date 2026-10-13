import { describe, expect, it } from "vitest";
import {
  classifyToolEffectPotential,
  remoteWorkerInferenceCanonicalSha256 as digest,
  type CapabilityCatalogEntry,
  type ChatTurnCapabilityToolRuntimeOwnerBinding,
} from "@goatcitadel/contracts";
import {
  selectRemoteAdmissionSchemas,
  buildRemoteAdmissionToolEvidence,
} from "./remote-worker-chat-admission-authority.js";

const definition = (name: string) => ({ type: "function", function: { name, parameters: { type: "object" } } });
const select = (names: string[], content = "Read a file") =>
  selectRemoteAdmissionSchemas({
    content,
    schema: {
      tools: names.map(definition),
      modelToCanonical: new Map(names.map((name) => [name, name.replaceAll("_", ".")])),
    },
    connections: [],
    mesh: [],
  });
const safe = classifyToolEffectPotential({ toolName: "fs.read", trustedBuiltin: true });
const catalog = [{ callable: true, toolName: "fs.read", effectPotential: safe }] as CapabilityCatalogEntry[];
const builtin: ChatTurnCapabilityToolRuntimeOwnerBinding = { kind: "builtin", bindingHash: digest("builtin") };

describe("remote admission selection preserves exposure and effect boundaries", () => {
  it("keeps explicit tools beyond the ordinary soft cap but refuses more than sixteen remote selections", () => {
    const names = Array.from({ length: 17 }, (_, index) => `tool_${index}`);
    expect(select(names)?.length).toBe(8);
    expect(select(names.slice(0, 16), names.map((name) => name.replaceAll("_", ".")).join(" "))?.length).toBe(16);
    expect(select(names, names.map((name) => name.replaceAll("_", ".")).join(" "))).toBeUndefined();
  });
  it("refuses a missing provider mapping instead of silently substituting a tool", () => {
    expect(() =>
      selectRemoteAdmissionSchemas({
        content: "read",
        schema: { tools: [definition("fs_read")], modelToCanonical: new Map() },
        connections: [],
        mesh: [],
      }),
    ).toThrow("exact model mapping");
  });
  it("binds exact schemas and preserves a trusted builtin read classification", () => {
    const selected = select(["fs_read"])!;
    const tools = buildRemoteAdmissionToolEvidence({
      selected,
      catalog,
      runtimeOwners: new Map([["fs.read", builtin]]),
      interpositionCount: 0,
    });
    expect(tools[0].effectPotential).toEqual(safe);
    expect(tools[0].definitionHash).toBe(digest(definition("fs_read")));
    expect(tools[0].runtimeOwner).toEqual(builtin);
  });
  it("never trusts builtin read hints for interposed, plugin or remote effects", () => {
    const selected = select(["fs_read"])!;
    const plugin: ChatTurnCapabilityToolRuntimeOwnerBinding = { kind: "plugin", bindingHash: digest("plugin") };
    for (const [owner, count] of [
      [builtin, 1],
      [plugin, 0],
    ] as const) {
      expect(
        buildRemoteAdmissionToolEvidence({
          selected,
          catalog,
          runtimeOwners: new Map([["fs.read", owner]]),
          interpositionCount: count,
        })[0].effectPotential.potential,
      ).toBe("unknown");
    }
    const remote = { canonicalName: "mcp.server.read", modelName: "mcp_read", definition: definition("mcp_read") };
    expect(
      buildRemoteAdmissionToolEvidence({
        selected: [remote],
        catalog: [],
        runtimeOwners: new Map([[remote.canonicalName, builtin]]),
        interpositionCount: 0,
      })[0].effectPotential.potential,
    ).toBe("unknown");
  });
  it("refuses revoked callable tools and missing current runtime owners", () => {
    const selected = select(["fs_read"])!;
    expect(() =>
      buildRemoteAdmissionToolEvidence({
        selected,
        catalog: [],
        runtimeOwners: new Map([["fs.read", builtin]]),
        interpositionCount: 0,
      }),
    ).toThrow("no longer callable");
    expect(() =>
      buildRemoteAdmissionToolEvidence({ selected, catalog, runtimeOwners: new Map(), interpositionCount: 0 }),
    ).toThrow("no current runtime owner");
  });
});
