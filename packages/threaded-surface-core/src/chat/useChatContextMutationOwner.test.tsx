import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import {
  __resetApprovalOperationAttemptsForTests,
  readApprovalOperationAttempt,
  hasUnsettledChatContextMutation,
  beginApprovalOperation,
  updateApprovalOperation,
} from "@goatcitadel/mission-control-shared/state/scoped-operation-attempts";
import { useChatSessionSelection } from "./controller/useChatSessionSelection";
import { useChatContextMutationOwner } from "./useChatContextMutationOwner";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const gate = vi.hoisted(() => ({
  caller: 0,
  access: 0,
  scope: { current: 0 },
  history: { current: 0 },
  selection: { current: 0 },
  sending: { current: 0 },
  installation: "http://gateway.test",
  status: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/hooks/use-current-access", () => ({
  useProjectAccess: (scope: string) => {
    const access = gate.access;
    return {
      identity: `${gate.installation}:${access}:${scope}`,
      presentationScope: JSON.stringify([gate.installation, "caller", scope]),
      current: () => gate.access === access,
    };
  },
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ scopeGenerationRef: gate.scope }),
}));
vi.mock("@goatcitadel/mission-control-shared/api/access-scope", () => ({
  getGatewayCallerScopeRevision: () => gate.caller,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => gate.installation,
  captureMutationAttempt: (dispatch: () => Promise<unknown>, capture: (value: unknown) => void) => {
    capture({
      attemptKey: "00000000-0000-4000-8000-000000000001",
      method: "POST",
      path: "/api/v1/chat/sessions/session/specialist-candidates",
      installation: gate.installation,
    });
    return dispatch();
  },
}));
vi.mock("@goatcitadel/mission-control-shared/api/mutation-attempts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchMutationAttempt: gate.status,
}));
let root: ReactTestRenderer | undefined;
let owner: ReturnType<typeof useChatContextMutationOwner>;
const errors: Array<string | null> = [];
function Harness({
  sessionId = "session",
  historicalReadOnly = false,
}: {
  sessionId?: string;
  historicalReadOnly?: boolean;
}) {
  owner = useChatContextMutationOwner({
    family: "specialists",
    workspaceId: "workspace",
    sessionId,
    historicalRevisionRef: gate.history,
    historicalReadOnly,
    selectionRevisionRef: gate.selection,
    sendingRevisionRef: gate.sending,
    setError: (value) => errors.push(value),
  });
  return null;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(async () => {
  __resetApprovalOperationAttemptsForTests();
  gate.caller =
    gate.access =
    gate.scope.current =
    gate.history.current =
    gate.selection.current =
    gate.sending.current =
      0;
  errors.length = 0;
  gate.status.mockReset();
  await act(async () => {
    root = create(
      <React.Activity mode="visible">
        <Harness />
      </React.Activity>,
    );
  });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  __resetApprovalOperationAttemptsForTests();
});
it("reserves the shared attempt synchronously and dispatches a duplicate intent zero times", async () => {
  const pending = deferred<{ id: string }>(),
    dispatch = vi.fn(() => pending.promise),
    publish = vi.fn();
  let action!: Promise<void>;
  await act(async () => {
    action = owner.run("specialist-draft", dispatch, (value) => [value.id], publish);
    await Promise.resolve();
  });
  await act(async () => {
    await owner.run("specialist-draft", dispatch, (value) => [value.id], publish);
  });
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(owner.projection.locked).toBe(true);
  await act(async () => {
    pending.resolve({ id: "candidate" });
    await action;
  });
  expect(publish).toHaveBeenCalledTimes(1);
  expect(owner.projection.phase).toBe("resolved");
  expect(owner.projection.receipt).toEqual({ kind: "specialist-draft", subjectIds: ["candidate"] });
});
it.each(["caller", "access", "scope", "selection", "history"] as const)(
  "suppresses stale post-await publication after %s ABA without erasing canonical receipt",
  async (change) => {
    const pending = deferred<{ id: string }>(),
      publish = vi.fn();
    let action!: Promise<void>;
    await act(async () => {
      action = owner.run(
        "specialist-draft",
        () => pending.promise,
        (value) => [value.id],
        publish,
      );
      await Promise.resolve();
    });
    if (change === "caller" || change === "access") gate[change] += 2;
    else gate[change].current += 2;
    await act(async () => {
      pending.resolve({ id: "original" });
      await action;
    });
    expect(publish).not.toHaveBeenCalled();
    const key = JSON.stringify([
      "library-operation",
      JSON.stringify([gate.installation, "caller", JSON.stringify(["chat-context", "workspace", "session"])]),
    ]);
    expect(readApprovalOperationAttempt(key)?.receipt?.subjectIds).toEqual(["original"]);
  },
);
it("keeps a lost response locked across remount, inspection and duplicate intent", async () => {
  const dispatch = vi.fn(async () => {
    throw new Error("response lost");
  });
  await act(async () => {
    await owner.run("specialist-draft", dispatch, () => ["invalid"], vi.fn());
  });
  expect(owner.projection.phase).toBe("uncertain");
  await act(async () => {
    root?.unmount();
    root = create(
      <React.Activity mode="visible">
        <Harness />
      </React.Activity>,
    );
  });
  gate.status.mockResolvedValue({ status: "completed" });
  const read = vi.fn(async () => ({ items: [{ id: "looks-like-result" }] }));
  await act(async () => {
    await owner.inspect(read, () => undefined, vi.fn());
    await owner.run("specialist-draft", dispatch, () => ["invalid"], vi.fn());
  });
  expect(gate.status).toHaveBeenCalledWith(
    "00000000-0000-4000-8000-000000000001",
    "POST",
    "/api/v1/chat/sessions/:sessionId/specialist-candidates",
  );
  expect(read).toHaveBeenCalledTimes(1);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(owner.projection.phase).toBe("uncertain");
  expect(owner.projection.locked).toBe(true);
  expect(owner.projection.receipt).toBeUndefined();
});
it.each(["completed", "failed", "pending", "absent"] as const)(
  "does not unlock uncertain writes from a %s status without subject linkage",
  async (status) => {
    await act(async () => {
      await owner.run(
        "specialist-draft",
        async () => {
          throw new Error("lost");
        },
        () => [],
        vi.fn(),
      );
    });
    gate.status.mockResolvedValue({ status });
    await act(async () => {
      await owner.inspect(
        async () => ({ items: [] }),
        () => undefined,
        vi.fn(),
      );
    });
    expect(owner.projection.phase).toBe("uncertain");
    expect(owner.projection.locked).toBe(true);
    expect(owner.projection.receipt).toBeUndefined();
  },
);
it("preserves canonical effect when publication or later inspection fails", async () => {
  const dispatch = vi.fn(async () => ({ id: "record" }));
  await act(async () => {
    await owner.run(
      "specialist-draft",
      dispatch,
      (value) => [value.id],
      () => {
        throw new Error("display failed");
      },
    );
  });
  expect(owner.projection.phase).toBe("resolved");
  expect(owner.projection.locked).toBe(false);
  expect(owner.projection.inspectionError).toContain("receipt is confirmed");
  await act(async () => {
    await owner.inspect(
      async () => {
        throw new Error("read failed");
      },
      () => undefined,
      vi.fn(),
    );
  });
  expect(owner.projection.phase).toBe("resolved");
  expect(owner.projection.receipt?.subjectIds).toEqual(["record"]);
  expect(dispatch).toHaveBeenCalledTimes(1);
});
it("retains uncertainty for a partial-write legacy400 and rejects a malformed receipt", async () => {
  await act(async () => {
    await owner.run(
      "specialist-draft",
      async () => {
        throw new ApiRequestError("legacy partial write", {
          kind: "http",
          method: "POST",
          path: "/api/v1/chat/sessions/session/specialist-candidates",
          status: 400,
        });
      },
      () => [],
      vi.fn(),
    );
  });
  expect(owner.projection.phase).toBe("uncertain");
  expect(owner.projection.locked).toBe(true);
  __resetApprovalOperationAttemptsForTests();
  await act(async () => {
    await owner.run(
      "specialist-draft",
      async () => ({}),
      () => {
        throw new TypeError("wrong record");
      },
      vi.fn(),
    );
  });
  expect(owner.projection.phase).toBe("uncertain");
  expect(owner.projection.receipt).toBeUndefined();
});
it("never clears a newer sending publication from an old finalizer", async () => {
  const pending = deferred<{ id: string }>(),
    end = vi.fn();
  let action!: Promise<void>;
  await act(async () => {
    action = owner.run(
      "specialist-draft",
      () => pending.promise,
      (value) => [value.id],
      vi.fn(),
      {
        begin: () => {
          gate.sending.current += 1;
        },
        end,
      },
    );
    await Promise.resolve();
  });
  gate.sending.current += 1;
  gate.caller += 2;
  await act(async () => {
    pending.resolve({ id: "original" });
    await action;
  });
  expect(end).not.toHaveBeenCalled();
});
it("suppresses pre-dispatch work after synchronous scope departure", async () => {
  const dispatch = vi.fn(async () => ({ id: "record" }));
  await act(async () => {
    const action = owner.run("specialist-draft", dispatch, (value) => [value.id], vi.fn(), {
      begin: () => {
        gate.selection.current += 2;
      },
      end: vi.fn(),
    });
    await action;
  });
  expect(dispatch).not.toHaveBeenCalled();
  expect(owner.projection.locked).toBe(false);
});

it("reads live document recovery blockers without React rerender and ignores other owner namespaces", () => {
  const unrelated = beginApprovalOperation(
    JSON.stringify(["library-operation", JSON.stringify(["install", "caller", "not-context"])]),
    "revision",
  )!;
  expect(unrelated).toBeDefined();
  expect(hasUnsettledChatContextMutation()).toBe(false);
  const key = JSON.stringify([
    "library-operation",
    JSON.stringify([
      "original-install",
      "original-caller",
      JSON.stringify(["chat-context", "old-workspace", "old-session"]),
    ]),
  ]);
  const token = beginApprovalOperation(key, "revision")!;
  expect(hasUnsettledChatContextMutation()).toBe(true);
  updateApprovalOperation(key, token, "uncertain", "lost response");
  expect(hasUnsettledChatContextMutation()).toBe(true);
  updateApprovalOperation(key, token, "resolved", "canonical receipt returned");
  expect(hasUnsettledChatContextMutation()).toBe(false);
});

it("revokes old Activity admission across hide/reveal without losing its original canonical receipt", async () => {
  const pending = deferred<{ id: string }>(),
    publish = vi.fn();
  let action!: Promise<void>;
  await act(async () => {
    action = owner.run(
      "specialist-draft",
      () => pending.promise,
      (value) => [value.id],
      publish,
    );
    await Promise.resolve();
  });
  await act(async () =>
    root!.update(
      <React.Activity mode="hidden">
        <Harness />
      </React.Activity>,
    ),
  );
  await act(async () =>
    root!.update(
      <React.Activity mode="visible">
        <Harness />
      </React.Activity>,
    ),
  );
  await act(async () => {
    pending.resolve({ id: "original" });
    await action;
  });
  expect(publish).not.toHaveBeenCalled();
  expect(owner.projection.receipt?.subjectIds).toEqual(["original"]);
});
it("refuses current historical views before POST and admits a fresh current view", async () => {
  const dispatch = vi.fn(async () => ({ id: "record" }));
  await act(async () =>
    root!.update(
      <React.Activity mode="visible">
        <Harness historicalReadOnly />
      </React.Activity>,
    ),
  );
  await act(async () => {
    await owner.run("specialist-draft", dispatch, (value) => [value.id], vi.fn());
  });
  expect(dispatch).not.toHaveBeenCalled();
  gate.history.current += 1;
  await act(async () =>
    root!.update(
      <React.Activity mode="visible">
        <Harness />
      </React.Activity>,
    ),
  );
  await act(async () => {
    await owner.run("specialist-draft", dispatch, (value) => [value.id], vi.fn());
  });
  expect(dispatch).toHaveBeenCalledTimes(1);
});

it("rechecks the existing busy publication after preflight and makes no POST when a newer owner intervenes", async () => {
  const dispatch = vi.fn(async () => ({ id: "record" }));
  let action!: Promise<void>;
  await act(async () => {
    action = owner.run("specialist-draft", dispatch, (value) => [value.id], vi.fn(), {
      begin: () => {
        gate.sending.current += 1;
      },
      end: vi.fn(),
    });
    gate.sending.current += 1;
    await action;
  });
  expect(dispatch).not.toHaveBeenCalled();
  expect(owner.projection.phase).toBe("refused");
  expect(owner.projection.message).toContain("No action was submitted");
});

it("preserves primitive no-op selection while detecting same-batch selection ABA and functional setters", async () => {
  let selection!: ReturnType<typeof useChatSessionSelection>;
  function SelectionHarness() {
    selection = useChatSessionSelection({ initialModeOverride: undefined });
    return null;
  }
  await act(async () => root!.update(<SelectionHarness />));
  await act(async () => selection.setSelectedSessionId("session"));
  const baseline = selection.selectedSessionRevisionRef.current;
  await act(async () => selection.setSelectedSessionId("session"));
  expect(selection.selectedSessionRevisionRef.current).toBe(baseline);
  await act(async () => {
    selection.setSelectedSessionId("other");
    selection.setSelectedSessionId("session");
  });
  expect(selection.selectedSessionId).toBe("session");
  expect(selection.selectedSessionRevisionRef.current).toBe(baseline + 2);
  await act(async () => selection.setSelectedSessionId((previous) => previous + "-next"));
  expect(selection.selectedSessionId).toBe("session-next");
});

it("admits a fresh action after StrictMode effect replay", async () => {
  await act(async () =>
    root!.update(
      <React.StrictMode>
        <Harness />
      </React.StrictMode>,
    ),
  );
  const dispatch = vi.fn(async () => ({ id: "strict-current" }));
  expect(owner.projection.isCurrent()).toBe(true);
  await act(async () => {
    await owner.run("specialist-draft", dispatch, (value) => [value.id], vi.fn());
  });
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(owner.projection.phase).toBe("resolved");
});

it("admits a fresh action after Activity reveal while revoking captured old admission", async () => {
  const oldRun = owner.run;
  await act(async () =>
    root!.update(
      <React.Activity mode="hidden">
        <Harness />
      </React.Activity>,
    ),
  );
  await act(async () =>
    root!.update(
      <React.Activity mode="visible">
        <Harness />
      </React.Activity>,
    ),
  );
  const dispatch = vi.fn(async () => ({ id: "revealed-current" }));
  expect(owner.projection.isCurrent()).toBe(true);
  await act(async () => {
    await oldRun("specialist-draft", dispatch, (value) => [value.id], vi.fn());
  });
  expect(dispatch).not.toHaveBeenCalled();
  await act(async () => {
    await owner.run("specialist-draft", dispatch, (value) => [value.id], vi.fn());
  });
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(owner.projection.phase).toBe("resolved");
});

it("does not query an old caller after inspection code loads", async () => {
  await act(async () => {
    await owner.run(
      "specialist-draft",
      async () => {
        throw new Error("response lost");
      },
      () => [],
      vi.fn(),
    );
  });
  const read = vi.fn(async () => ({ items: [] }));
  await act(async () => {
    const inspection = owner.inspect(read, () => undefined, vi.fn());
    gate.caller += 1;
    await inspection;
  });
  expect(gate.status).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(owner.projection.locked).toBe(true);
});

it("does not infer Gateway health from an uncertain transport response", async () => {
  await act(async () => {
    await owner.run(
      "specialist-draft",
      async () => {
        throw new ApiRequestError("Failed to fetch", {
          kind: "network",
          method: "POST",
          path: "/api/v1/chat/sessions/session/specialist-candidates",
        });
      },
      () => [],
      vi.fn(),
    );
  });
  expect(owner.projection.phase).toBe("uncertain");
  expect(owner.projection.locked).toBe(true);
  expect(owner.projection.message).toContain("original mutation outcome is unknown");
  expect(errors).toEqual([]);
});
it("still exposes a definitive permission refusal without retaining an uncertain lock", async () => {
  await act(async () => {
    await owner.run(
      "specialist-draft",
      async () => {
        throw new ApiRequestError("Forbidden", {
          kind: "http",
          status: 403,
          method: "POST",
          path: "/api/v1/chat/sessions/session/specialist-candidates",
        });
      },
      () => [],
      vi.fn(),
    );
  });
  expect(owner.projection.phase).toBe("refused");
  expect(owner.projection.locked).toBe(false);
  expect(errors).toHaveLength(1);
});
