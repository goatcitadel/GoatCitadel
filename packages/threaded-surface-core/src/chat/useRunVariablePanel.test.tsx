import React, { createRef } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { RUN_VARIABLE_SCHEMA_VERSION, type RunVariableSchema } from "@goatcitadel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRunVariablePanel } from "./useRunVariablePanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const schema: RunVariableSchema = {
  version: RUN_VARIABLE_SCHEMA_VERSION,
  fields: [{ id: "topic", label: "Topic", type: "text", required: true }],
};
const setDraft = vi.fn();
const composerRef = createRef<HTMLTextAreaElement>();
let current: ReturnType<typeof useRunVariablePanel>;
let renderer: ReactTestRenderer | null = null;

function Harness({ sessionId = "session-one" }: { sessionId?: string }) {
  current = useRunVariablePanel({ selectedSessionId: sessionId, setDraft, composerRef });
  return null;
}

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = null;
  setDraft.mockClear();
});

describe("run-variable panel", () => {
  it("validates typed values before capturing a resolved template invocation", async () => {
    await act(async () => {
      renderer = create(<Harness />);
    });
    await act(async () => {
      current.openForm({
        title: "Research topic",
        invocation: { ownerKind: "prompt_pack", ownerId: "pack", ownerRevision: "1", schemaHash: "schema" },
        schema,
        template: "Research {{topic}}.",
      });
    });
    expect(current.runVariablePanel?.open).toBe(true);
    expect(current.runVariablePanel?.error).toMatch(/topic/i);

    await act(async () => current.runVariablePanel?.onValueChange("topic", "goats"));
    expect(current.runVariablePanel?.preview).toBe("Research goats.");
    expect(current.runVariablePanel?.error).toBeNull();

    await act(async () => current.runVariablePanel?.onApply());
    expect(current.runVariablePanel).toBeUndefined();
    expect(current.pendingTemplateInvocation).toMatchObject({
      invocation: { ownerId: "pack", values: { topic: "goats" } },
      resolvedContent: "Research goats.",
    });
    expect(setDraft).toHaveBeenCalledWith("Research goats.");
  });

  it("clears the form and unsent invocation when the selected chat changes", async () => {
    await act(async () => {
      renderer = create(<Harness />);
    });
    await act(async () => {
      current.openForm({
        title: "Research topic",
        invocation: { ownerKind: "prompt_pack", ownerId: "pack", ownerRevision: "1", schemaHash: "schema" },
        schema,
        template: "Research {{topic}}.",
        defaults: { topic: "goats" },
      });
    });
    await act(async () => current.runVariablePanel?.onApply());
    expect(current.pendingTemplateInvocation).not.toBeNull();
    await act(async () => renderer?.update(<Harness sessionId="session-two" />));
    expect(current.runVariablePanel).toBeUndefined();
    expect(current.pendingTemplateInvocation).toBeNull();
  });
});
