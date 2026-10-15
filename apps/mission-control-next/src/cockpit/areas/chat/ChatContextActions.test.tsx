// @vitest-environment happy-dom
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MissionThreadedContextDockProps } from "@goatcitadel/threaded-surface-core";
import { ChatContextActions } from "./ChatContextActions";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "../../../features/native-routes/library/use-form-dirty";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const gate = vi.hoisted(() => ({ caller: 0 }));
vi.mock("@goatcitadel/mission-control-shared/api/access-scope", () => ({
  getGatewayCallerScopeRevision: () => gate.caller,
  getGatewayCallerScope: () => "caller",
  subscribeGatewayCallerScope: () => () => undefined,
}));
vi.mock("@goatcitadel/mission-control-shared/components/ConfirmModal", () => ({
  ConfirmModal: (props: { open: boolean; confirmDisabled: boolean; onConfirm: () => void; onCancel: () => void }) =>
    props.open ? (
      <section data-review>
        <button type="button" disabled={props.confirmDisabled} onClick={props.onConfirm}>
          Confirm review
        </button>
        <button type="button" onClick={props.onCancel}>
          Cancel review
        </button>
      </section>
    ) : null,
}));
let root: ReactTestRenderer | undefined;
const actions = {
  draft: vi.fn(async () => undefined),
  activate: vi.fn(async () => undefined),
  status: vi.fn(async () => undefined),
  rebuild: vi.fn(async () => undefined),
  binding: vi.fn(async () => undefined),
  inspect: vi.fn(async () => undefined),
};
function fixture(): MissionThreadedContextDockProps {
  const owner = (family: string) => ({
    family,
    workspaceId: "workspace",
    sessionId: "session",
    scopeIdentity: "scope",
    phase: "idle",
    locked: false,
    isCurrent: () => true,
    onInspect: actions.inspect,
  });
  return {
    selectedSessionId: "session",
    selectedSession: { sessionId: "session", workspaceId: "workspace", title: "Reviewed conversation" },
    sending: false,
    sessionControlPending: null,
    specialistSuggestions: [
      { candidateId: "catalog", title: "Analyst", summary: "Review risks", reason: "Relevant", source: "catalog" },
    ],
    specialistCandidates: [],
    learnedMemory: [{ itemId: "memory", sessionId: "session", content: "Recorded fact", status: "active" }],
    binding: null,
    contextMutations: {
      specialists: owner("specialists"),
      learnedMemory: owner("learned-memory"),
      binding: owner("binding"),
    },
    onCreateSpecialistDraft: actions.draft,
    onActivateCatalogSpecialist: actions.activate,
    onUpdateMemoryStatus: actions.status,
    onRebuildLearnedMemory: actions.rebuild,
    onSaveExternalBinding: actions.binding,
  } as unknown as MissionThreadedContextDockProps;
}
function button(label: string) {
  return root!.root.findAllByType("button").find(
    (node) =>
      node.children
        .map((child) => (typeof child === "string" ? child : child.children.join("")))
        .join("")
        .replace(/\s+/g, " ")
        .trim() === label,
  )!;
}
beforeEach(() => {
  gate.caller = 0;
  Object.values(actions).forEach((action) => action.mockClear());
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
});
it("Cancel submits no specialist, memory or binding mutation", async () => {
  const dock = fixture();
  await act(async () => {
    root = create(<ChatContextActions dock={dock} />);
  });
  for (const label of ["Draft", "Activate", "Keep active", "Mark stale", "Rebuild learned memory"]) {
    await act(async () => button(label).props.onClick());
    await act(async () => button("Cancel review").props.onClick());
  }
  await act(async () => root!.root.findAllByType("input")[0]!.props.onChange({ target: { value: "connection" } }));
  await act(async () => root!.root.findAllByType("input")[1]!.props.onChange({ target: { value: "target" } }));
  await act(async () => button("Save binding").props.onClick());
  await act(async () => button("Cancel review").props.onClick());
  expect(actions.draft).not.toHaveBeenCalled();
  expect(actions.activate).not.toHaveBeenCalled();
  expect(actions.status).not.toHaveBeenCalled();
  expect(actions.rebuild).not.toHaveBeenCalled();
  expect(actions.binding).not.toHaveBeenCalled();
});
it("invokes the original action once and never treats Promise<void> as a receipt", async () => {
  const dock = fixture();
  await act(async () => {
    root = create(<ChatContextActions dock={dock} />);
  });
  await act(async () => button("Draft").props.onClick());
  const confirm = button("Confirm review").props.onClick;
  await act(async () => {
    confirm();
    confirm();
  });
  await act(async () => confirm());
  expect(actions.draft).toHaveBeenCalledTimes(1);
  expect(actions.draft).toHaveBeenCalledWith(dock.specialistSuggestions[0]);
  expect(JSON.stringify(root!.toJSON())).not.toContain("Canonical receipt identifiers");
});
it.each(["caller", "record"] as const)("rejects the connected old review after %s changes", async (change) => {
  const dock = fixture();
  await act(async () => {
    root = create(<ChatContextActions dock={dock} />);
  });
  await act(async () => button("Draft").props.onClick());
  const confirm = button("Confirm review").props.onClick;
  if (change === "caller") gate.caller += 2;
  else
    await act(async () =>
      root!.update(
        <ChatContextActions
          dock={{ ...dock, specialistSuggestions: [{ ...dock.specialistSuggestions[0]!, summary: "Changed record" }] }}
        />,
      ),
    );
  await act(async () => confirm());
  expect(actions.draft).not.toHaveBeenCalled();
});
it("passes the exact reviewed binding without racing React input setters", async () => {
  const dock = fixture();
  await act(async () => {
    root = create(<ChatContextActions dock={dock} />);
  });
  await act(async () => root!.root.findAllByType("input")[0]!.props.onChange({ target: { value: " connection " } }));
  await act(async () => root!.root.findAllByType("input")[1]!.props.onChange({ target: { value: " target " } }));
  await act(async () => button("Save binding").props.onClick());
  await act(async () => button("Confirm review").props.onClick());
  expect(actions.binding).toHaveBeenCalledTimes(1);
  expect(actions.binding).toHaveBeenCalledWith({ connectionId: "connection", target: "target" });
});
it("keeps unknown writes blocked while preserving supported inspection", async () => {
  const dock = fixture();
  dock.contextMutations!.specialists = {
    ...dock.contextMutations!.specialists,
    phase: "uncertain",
    locked: true,
    message: "Unknown original result",
  };
  await act(async () => {
    root = create(<ChatContextActions dock={dock} />);
  });
  expect(button("Draft").props.disabled).toBe(true);
  expect(button("Rebuild learned memory").props.disabled).toBe(true);
  await act(async () => button("Inspect current specialists").props.onClick());
  expect(actions.inspect).toHaveBeenCalledTimes(1);
  expect(actions.draft).not.toHaveBeenCalled();
});

it("rejects binding edit-and-back ABA through the existing draft owner's live version", async () => {
  const dock = fixture();
  await act(async () => {
    root = create(<ChatContextActions dock={dock} />);
  });
  await act(async () => root!.root.findAllByType("input")[0]!.props.onChange({ target: { value: "connection" } }));
  await act(async () => root!.root.findAllByType("input")[1]!.props.onChange({ target: { value: "target" } }));
  await act(async () => button("Save binding").props.onClick());
  const confirm = button("Confirm review").props.onClick;
  const edit = root!.root.findAllByType("input")[0]!.props.onChange;
  await act(async () => {
    edit({ target: { value: "other" } });
    edit({ target: { value: "connection" } });
    confirm();
  });
  expect(actions.binding).not.toHaveBeenCalled();
});

it("does not dispatch a connected confirmation after its inspector owner unmounts", async () => {
  const dock = fixture();
  await act(async () => {
    root = create(<ChatContextActions dock={dock} />);
  });
  await act(async () => button("Rebuild learned memory").props.onClick());
  const confirm = button("Confirm review").props.onClick;
  await act(async () => root!.unmount());
  await act(async () => confirm());
  expect(actions.rebuild).not.toHaveBeenCalled();
  root = undefined;
});

it("acknowledges the submitted whitespace draft only after its canonical binding receipt", async () => {
  let dock = fixture();
  await act(async () => {
    root = create(<ChatContextActions dock={dock} />);
  });
  await act(async () => root!.root.findAllByType("input")[0]!.props.onChange({ target: { value: " connection " } }));
  await act(async () => root!.root.findAllByType("input")[1]!.props.onChange({ target: { value: " target " } }));
  await act(async () => button("Save binding").props.onClick());
  await act(async () => button("Confirm review").props.onClick());
  expect(button("Discard draft").props.disabled).toBe(false);
  dock = {
    ...dock,
    binding: {
      sessionId: "session",
      transport: "integration",
      connectionId: "connection",
      target: "target",
      writable: true,
      createdAt: "2026-10-14T00:00:00.000Z",
      updatedAt: "2026-10-14T00:00:01.000Z",
    },
    contextMutations: {
      ...dock.contextMutations!,
      binding: {
        ...dock.contextMutations!.binding,
        phase: "resolved",
        receipt: { kind: "external-binding", subjectIds: ["session"] },
      },
    },
  };
  await act(async () => root!.update(<ChatContextActions dock={dock} />));
  expect(root!.root.findAllByType("input").map((node) => node.props.value)).toEqual(["connection", "target"]);
  expect(button("Discard draft").props.disabled).toBe(true);
  await act(async () => root!.root.findAllByType("input")[1]!.props.onChange({ target: { value: "next-target" } }));
  expect(button("Save binding").props.disabled).toBe(false);
  expect(JSON.stringify(root!.toJSON())).not.toContain("canonical binding changed while this draft");
  expect(actions.binding).toHaveBeenCalledTimes(1);
});
it("preserves edits made after submission when the original binding receipt arrives", async () => {
  let dock = fixture();
  await act(async () => {
    root = create(<ChatContextActions dock={dock} />);
  });
  await act(async () => root!.root.findAllByType("input")[0]!.props.onChange({ target: { value: " connection " } }));
  await act(async () => root!.root.findAllByType("input")[1]!.props.onChange({ target: { value: " target " } }));
  await act(async () => button("Save binding").props.onClick());
  await act(async () => button("Confirm review").props.onClick());
  await act(async () => root!.root.findAllByType("input")[1]!.props.onChange({ target: { value: "newer-input" } }));
  dock = {
    ...dock,
    binding: {
      sessionId: "session",
      transport: "integration",
      connectionId: "connection",
      target: "target",
      writable: true,
      createdAt: "2026-10-14T00:00:00.000Z",
      updatedAt: "2026-10-14T00:00:01.000Z",
    },
    contextMutations: {
      ...dock.contextMutations!,
      binding: {
        ...dock.contextMutations!.binding,
        phase: "resolved",
        receipt: { kind: "external-binding", subjectIds: ["session"] },
      },
    },
  };
  await act(async () => root!.update(<ChatContextActions dock={dock} />));
  expect(root!.root.findAllByType("input").map((node) => node.props.value)).toEqual([" connection ", "newer-input"]);
  expect(button("Discard draft").props.disabled).toBe(false);
  expect(button("Save binding").props.disabled).toBe(true);
  expect(actions.binding).toHaveBeenCalledTimes(1);
});
it("does not acknowledge an uncertain write even when current binding readback matches", async () => {
  let dock = fixture();
  await act(async () => {
    root = create(<ChatContextActions dock={dock} />);
  });
  await act(async () => root!.root.findAllByType("input")[0]!.props.onChange({ target: { value: " connection " } }));
  await act(async () => root!.root.findAllByType("input")[1]!.props.onChange({ target: { value: " target " } }));
  await act(async () => button("Save binding").props.onClick());
  await act(async () => button("Confirm review").props.onClick());
  dock = {
    ...dock,
    binding: {
      sessionId: "session",
      transport: "integration",
      connectionId: "connection",
      target: "target",
      writable: true,
      createdAt: "2026-10-14T00:00:00.000Z",
      updatedAt: "2026-10-14T00:00:01.000Z",
    },
    contextMutations: {
      ...dock.contextMutations!,
      binding: { ...dock.contextMutations!.binding, phase: "uncertain", locked: true },
    },
  };
  await act(async () => root!.update(<ChatContextActions dock={dock} />));
  expect(root!.root.findAllByType("input").map((node) => node.props.value)).toEqual([" connection ", " target "]);
  expect(button("Discard draft").props.disabled).toBe(false);
  expect(button("Save binding").props.disabled).toBe(true);
  expect(actions.binding).toHaveBeenCalledTimes(1);
});
