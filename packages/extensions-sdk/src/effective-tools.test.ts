import { describe, expect, it, vi } from "vitest";
import type { CompactToolDirectorySnapshot } from "@goatcitadel/contracts";
import {
  buildToolSchemaRefIndex,
  dereferenceEffectiveToolSchema,
  findEffectiveToolByName,
  listEffectiveCallableTools,
  validateCompactToolDirectorySnapshot,
} from "./effective-tools.js";

describe("effective tool SDK helpers", () => {
  it("validates and lists Gateway-owned compact callable tool snapshots", () => {
    const snapshot = fixtureSnapshot();

    expect(validateCompactToolDirectorySnapshot(snapshot)).toEqual({
      ok: true,
      errors: [],
      callableToolCount: 2,
      schemaRefCount: 2,
    });
    expect(listEffectiveCallableTools(snapshot).map((tool) => tool.toolName)).toEqual(["memory.search", "fs.read"]);
    expect(findEffectiveToolByName(snapshot, "fs.read")).toMatchObject({
      capabilityId: "tool:fs.read",
      codeModeAllowed: true,
    });
  });

  it("indexes schema refs by tool name and ref id without fetching full schemas", () => {
    const index = buildToolSchemaRefIndex(fixtureSnapshot());

    expect(index.get("memory.search")).toMatchObject({
      refId: "schema:memory.search:abc",
      schemaUri: "/api/v1/capabilities/tool-directory/schemas/memory.search",
    });
    expect(index.get("schema:fs.read:def")).toMatchObject({
      toolName: "fs.read",
      schemaHash: "def",
    });
  });

  it("dereferences tool schemas through a caller-supplied Gateway fetcher", async () => {
    const fetcher = vi.fn(async (ref) => ({
      title: ref.toolName,
      type: "object",
      hash: ref.schemaHash,
    }));

    const result = await dereferenceEffectiveToolSchema(fixtureSnapshot(), "memory.search", fetcher);

    expect(fetcher).toHaveBeenCalledWith(
      expect.objectContaining({
        refId: "schema:memory.search:abc",
        toolName: "memory.search",
      }),
    );
    expect(result.schema).toEqual({
      title: "memory.search",
      type: "object",
      hash: "abc",
    });
  });

  it("rejects malformed snapshots with readable validation errors", () => {
    const result = validateCompactToolDirectorySnapshot({
      version: "full-tool-directory.v1",
      source: "inspectable_catalog",
      tools: [{ toolName: "" }],
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "snapshot.version must be compact-tool-directory.v1",
        "snapshot.source must be callable_catalog",
        "tools.0.schemaRef must be a ToolSchemaRef",
      ]),
    );
  });
});

function fixtureSnapshot(): CompactToolDirectorySnapshot {
  return {
    snapshotId: "compact-tools-1",
    version: "compact-tool-directory.v1",
    source: "callable_catalog",
    createdAt: "2026-06-20T00:00:00.000Z",
    expiresAt: "2026-06-20T00:01:00.000Z",
    ttlMs: 60_000,
    hash: "snapshot-hash",
    toolCount: 2,
    tools: [
      {
        capabilityId: "tool:memory.search",
        toolName: "memory.search",
        title: "Search memory",
        summary: "Find relevant memories.",
        riskLabel: "read",
        readOnly: true,
        deterministic: false,
        codeModeAllowed: false,
        schemaRef: {
          refId: "schema:memory.search:abc",
          toolName: "memory.search",
          schemaHash: "abc",
          schemaUri: "/api/v1/capabilities/tool-directory/schemas/memory.search",
        },
      },
      {
        capabilityId: "tool:fs.read",
        toolName: "fs.read",
        title: "Read file",
        summary: "Read a file inside policy jail.",
        riskLabel: "read",
        readOnly: true,
        deterministic: true,
        codeModeAllowed: true,
        schemaRef: {
          refId: "schema:fs.read:def",
          toolName: "fs.read",
          schemaHash: "def",
          schemaUri: "/api/v1/capabilities/tool-directory/schemas/fs.read",
        },
      },
    ],
    omitted: {
      inspectableOnlyCount: 3,
      reason: "callable_only",
    },
  };
}
