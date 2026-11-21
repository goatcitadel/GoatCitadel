import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type {
  ChangePlanRecord,
  ChatSessionPrefsPatch,
  ChatSessionPrefsRecord,
  ChatSessionRecord,
} from "@goatcitadel/contracts";
import {
  getGatewayAccessRevision,
  getGatewayCallerScopeRevision,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import type { ChatThreadNotice } from "@goatcitadel/mission-control-shared/components/chat/ChatThreadPrimitives";
import { isTerminalChangePlanStatus } from "./change-plan-controller-helpers";
import { useCommitRefValue } from "./retained-reload";
import type { ChatChangePlanState } from "./useChatChangePlanState";

export type Input = Pick<
  ChatChangePlanState,
  "setChatChangePlanSnapshot" | "setActiveChangePlan" | "setLinkedDefaultChangePlan" | "setChangePlanActionError"
> & {
  workspaceId: string;
  selectedSession: ChatSessionRecord | null;
  prefs: ChatSessionPrefsRecord | null;
  prefsRef: RefObject<ChatSessionPrefsRecord | null>;
  setPrefs: Dispatch<SetStateAction<ChatSessionPrefsRecord | null>>;
  selectedProviderId: string | undefined;
  selectedModel: string | undefined;
  setUiError: (value: string | null) => void;
  pushLocalNotice: (content: string, tone?: ChatThreadNotice["tone"]) => void;
};

type ModelPlanCode = typeof import("./chat-model-plan-actions");
let modelPlanCode: Promise<ModelPlanCode> | undefined;
function loadModelPlanCode() {
  return (modelPlanCode ??= import("./chat-model-plan-actions").catch((error: unknown) => {
    modelPlanCode = undefined;
    throw error;
  }));
}

export function useChatModelChangePlans(input: Input) {
  const {
    workspaceId,
    selectedSession,
    setChatChangePlanSnapshot,
    setActiveChangePlan,
    setLinkedDefaultChangePlan,
    setChangePlanActionError,
  } = input;
  // The Chat and workspace shown now, synced at commit. A change confirms against the Gateway for the Chat it was
  // started in; what it learns is published only while that Chat is still the one shown (the same rule as the
  // Chat's own state loads). A Chat opened later reads its own settings.
  const sessionId = selectedSession?.sessionId ?? null;
  const view = useMemo(() => ({ workspaceId, sessionId }), [workspaceId, sessionId]);
  const shownScope = useRef(view);
  useCommitRefValue(shownScope, view);
  const isShown = useCallback(
    (scopeWorkspaceId: string, sessionId: string | null | undefined) =>
      Boolean(sessionId) &&
      shownScope.current.sessionId === sessionId &&
      shownScope.current.workspaceId === scopeWorkspaceId,
    [],
  );
  const recordChangePlanResult = useCallback(
    (updated: ChangePlanRecord) => {
      setChatChangePlanSnapshot((current) => {
        const ownerSessionId = updated.origin.sessionId ?? null;
        if (current.ownerSessionId !== ownerSessionId) return current;
        return {
          ownerSessionId,
          items: [updated, ...current.items.filter((item) => item.planId !== updated.planId)].slice(0, 12),
        };
      });
      if (updated.requiredAction && !isTerminalChangePlanStatus(updated.status)) {
        setActiveChangePlan(updated);
      } else {
        setActiveChangePlan((current) => (current?.planId === updated.planId ? null : current));
      }
      return updated;
    },
    [setActiveChangePlan, setChatChangePlanSnapshot],
  );
  const reviewChatChangePlan = useCallback(
    (plan: ChangePlanRecord) => {
      setChangePlanActionError(null);
      setLinkedDefaultChangePlan(null);
      setActiveChangePlan(plan);
    },
    [setActiveChangePlan, setChangePlanActionError, setLinkedDefaultChangePlan],
  );
  const currentInput = useRef(input);
  useCommitRefValue(currentInput, input);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const dispatch = useCallback(
    (run: (actions: ReturnType<ModelPlanCode["createChatModelPlanActions"]>) => void | Promise<void>) => {
      const snapshot = currentInput.current;
      const scope = shownScope.current;
      const installation = getGatewayApiBaseUrl();
      const access = getGatewayAccessRevision();
      const caller = getGatewayCallerScopeRevision();
      const current = () =>
        mounted.current &&
        shownScope.current === scope &&
        getGatewayApiBaseUrl() === installation &&
        getGatewayAccessRevision() === access &&
        getGatewayCallerScopeRevision() === caller;
      return loadModelPlanCode()
        .then(({ createChatModelPlanActions }) => {
          if (!current()) return;
          return run(
            createChatModelPlanActions(
              snapshot,
              current,
              (workspace, session) => current() && isShown(workspace, session),
              recordChangePlanResult,
            ),
          );
        })
        .catch((error: unknown) => {
          if (current())
            snapshot.setUiError(describeApiError(error, "Unable to load the model change controls.").summary);
        });
    },
    [isShown, recordChangePlanResult],
  );
  const requestThreadModelPatch = useCallback(
    (patch: ChatSessionPrefsPatch) => dispatch((actions) => actions.requestThreadModelPatch(patch)),
    [dispatch],
  );
  const cancelPendingChatChangePlan = useCallback(
    (plan: ChangePlanRecord) => dispatch((actions) => actions.cancelPendingChatChangePlan(plan)),
    [dispatch],
  );
  const makeChatChangePlanDefault = useCallback(
    (plan: ChangePlanRecord) => dispatch((actions) => actions.makeChatChangePlanDefault(plan)),
    [dispatch],
  );
  return {
    requestThreadModelPatch,
    reviewChatChangePlan,
    cancelPendingChatChangePlan,
    makeChatChangePlanDefault,
    recordChangePlanResult,
  };
}
