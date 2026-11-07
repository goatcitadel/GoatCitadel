import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  getGatewayAccessRevision,
  getGatewayCallerScope,
  getGatewayCallerScopeRevision,
  subscribeGatewayAccessChange,
  subscribeGatewayCallerScope,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import {
  listWorkbenchDrafts,
  scopeWorkbenchDraftSession,
  useWorkbenchDraftVersion,
} from "./workbench-session-drafts.js";
import type { WorkbenchRuntime, WorkbenchSnapshot } from "./WorkbenchRuntime.js";

let runtimePromise: Promise<typeof WorkbenchRuntime> | undefined;

function loadRuntime() {
  return (runtimePromise ??= import("./WorkbenchRuntime.js").then(
    (module) => module.WorkbenchRuntime,
    (cause: unknown) => {
      runtimePromise = undefined;
      throw cause;
    },
  ));
}

const noop = () => undefined;
const noRefresh = async () => undefined;
const unavailable = async () => false;
const noResult = async () => null;
const closedWorkbench: WorkbenchSnapshot = {
  workbenchState: null,
  workbenchTree: null,
  selectedWorkbenchFile: null,
  selectedWorkbenchFileDiff: null,
  workbenchDraftContent: "",
  workbenchExpandedPaths: [],
  workbenchDiff: null,
  workbenchOutput: null,
  workbenchLoading: false,
  workbenchBusy: false,
  workbenchSaving: false,
  workbenchError: null,
  hasDirtyWorkbenchDraft: false,
  workbenchHasRemoteChanges: false,
  workbenchDraftPaths: [],
  rebaseWorkbenchDraft: noop,
  setWorkbenchDraftContent: noop,
  setWorkbenchExpandedPaths: noop,
  refreshWorkbench: noRefresh,
  createWorkbenchWorktree: noRefresh,
  openWorkbenchFile: unavailable,
  saveWorkbenchFile: unavailable,
  previewWorkbenchFileOperation: noResult,
  runWorkbenchFileOperation: unavailable,
  discardWorkbenchDraft: noop,
  runWorkbenchValidationCommand: unavailable,
  applyWorkbenchPatch: unavailable,
  exportWorkbenchPatch: noResult,
  revertWorkbenchFile: unavailable,
  revertWorkbenchAll: unavailable,
};

function sameWorkbenchSnapshot(left: WorkbenchSnapshot, right: WorkbenchSnapshot) {
  return (Object.keys(left) as Array<keyof WorkbenchSnapshot>).every((key) => left[key] === right[key]);
}

/** Load the file editor owner only when the owning surface has opened it. */
export function useDeferredChatWorkbench({
  sessionId,
  workspaceId,
  enabled,
}: {
  sessionId: string | null;
  workspaceId?: string;
  enabled: boolean;
}) {
  const access = useSyncExternalStore(subscribeGatewayAccessChange, getGatewayAccessRevision, getGatewayAccessRevision);
  const caller = useSyncExternalStore(
    subscribeGatewayCallerScope,
    getGatewayCallerScopeRevision,
    getGatewayCallerScopeRevision,
  );
  const installation = getGatewayApiBaseUrl();
  const [attempt, retry] = useState(0);
  const owner = useMemo(
    () => (enabled && sessionId ? { sessionId, workspaceId, access, caller, installation, attempt } : null),
    [enabled, sessionId, workspaceId, access, caller, installation, attempt],
  );
  const committedOwner = useRef<typeof owner>(null);
  const [runtime, setRuntime] = useState<typeof WorkbenchRuntime>();
  const [failedOwner, setFailedOwner] = useState<typeof owner>(null);
  const [publication, setPublication] = useState<{ owner: NonNullable<typeof owner>; snapshot: WorkbenchSnapshot }>();

  const isCurrentOwner = useCallback(
    () =>
      owner !== null &&
      committedOwner.current === owner &&
      owner.access === getGatewayAccessRevision() &&
      owner.caller === getGatewayCallerScopeRevision() &&
      owner.installation === getGatewayApiBaseUrl(),
    [owner],
  );
  useLayoutEffect(() => {
    committedOwner.current = owner;
    return () => {
      committedOwner.current = null;
    };
  }, [owner]);

  useEffect(() => {
    setPublication((current) => (current?.owner === owner ? current : undefined));
    if (!owner || runtime) return;
    let cancelled = false;
    void loadRuntime().then(
      (loaded) => {
        if (!cancelled && isCurrentOwner()) setRuntime(() => loaded);
      },
      () => {
        if (!cancelled && isCurrentOwner()) setFailedOwner(owner);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [isCurrentOwner, owner, runtime]);

  const publish = useCallback(
    (snapshot: WorkbenchSnapshot) => {
      if (!owner || !isCurrentOwner()) return;
      setPublication((current) =>
        current?.owner === owner && sameWorkbenchSnapshot(current.snapshot, snapshot) ? current : { owner, snapshot },
      );
    },
    [isCurrentOwner, owner],
  );
  const retryLoad = useCallback(async () => {
    if (isCurrentOwner()) retry((value) => value + 1);
  }, [isCurrentOwner]);

  const draftVersion = useWorkbenchDraftVersion();
  const callerScope = getGatewayCallerScope();
  const retainedDraftPaths = useMemo(() => {
    // The draft store exposes the revision separately from the draft records.
    void draftVersion;
    return listWorkbenchDrafts(sessionId ? scopeWorkbenchDraftSession(callerScope, sessionId) : null).map(
      (draft) => draft.base.path,
    );
  }, [callerScope, draftVersion, sessionId]);
  const failed = owner !== null && failedOwner === owner;
  const snapshot = owner !== null && publication?.owner === owner ? publication.snapshot : undefined;
  const workbenchRuntimeStatus: "loading" | "unavailable" | undefined =
    snapshot ? undefined : failed ? "unavailable" : "loading";
  const workbench =
    snapshot ?? {
      ...closedWorkbench,
      workbenchDraftPaths: retainedDraftPaths,
      workbenchLoading: owner !== null && !failed,
    };
  const Runtime = runtime;
  const workbenchRuntime =
    owner && Runtime ? (
      <Runtime
        key={JSON.stringify(owner)}
        sessionId={owner.sessionId}
        workspaceId={owner.workspaceId}
        isCurrentOwner={isCurrentOwner}
        publish={publish}
      />
    ) : null;
  return { workbench, workbenchRuntime, workbenchRuntimeStatus, retryWorkbenchRuntime: retryLoad };
}
