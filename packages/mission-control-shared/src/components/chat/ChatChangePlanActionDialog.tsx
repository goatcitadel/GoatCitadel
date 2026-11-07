import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { PageErrorBoundary } from "../PageErrorBoundary";
import { secureFields } from "./change-plan-secure-fields";
const ChatChangePlanActionDialogBody = lazy(async () => ({
  default: (await import("./ChatChangePlanActionDialogBody")).ChatChangePlanActionDialogBody,
}));
import type { ChangePlanPublicFormField, ChangePlanRecord, ChangePlanRequiredAction } from "@goatcitadel/contracts";
import { GCModal } from "../ui";
import { fetchCandidateSkillArtifactReview, fetchCapabilityCandidate } from "../../api/capabilities";
import type { CandidateSkillArtifactReview } from "@goatcitadel/contracts";

export type ChangePlanPublicValues = Readonly<Record<string, string | number | boolean>>;

export interface ChatChangePlanActionDialogProps {
  readonly plan: ChangePlanRecord | null;
  readonly linkedPlan?: ChangePlanRecord | null;
  readonly pending?: boolean;
  /** The action waits on something outside the dialog: confirm shows working, but the dialog stays closable. */
  readonly waiting?: boolean;
  readonly error?: string | null;
  readonly contextNote?: string;
  readonly onClose: () => void;
  readonly onConfirm: (plan: ChangePlanRecord) => void | Promise<void>;
  readonly onSubmitPublicForm: (plan: ChangePlanRecord, values: ChangePlanPublicValues) => void | Promise<void>;
  readonly onSubmitSecureInput: (
    plan: ChangePlanRecord,
    values: Readonly<Record<string, string>>,
  ) => void | Promise<void>;
  readonly onContinueOAuth: (plan: ChangePlanRecord) => void | Promise<void>;
  readonly onOpenApproval?: (plan: ChangePlanRecord) => void | Promise<void>;
  /** A host can supply its guarded owner link; Classic callback behavior remains the default. */
  readonly renderApprovalAction?: (plan: ChangePlanRecord, pending: boolean) => ReactNode;
  readonly onReviewArtifacts: (plan: ChangePlanRecord) => void | Promise<void>;
  readonly onOpenNativePathPicker: (plan: ChangePlanRecord) => void | Promise<void>;
}

/**
 * Renders only server-described Change Plan actions. Secret input is held in
 * component memory only and cleared before the owner callback resolves. Native
 * paths never have a text input and therefore cannot enter a generic response.
 */
export function ChatChangePlanActionDialog({
  plan,
  linkedPlan,
  pending = false,
  waiting = false,
  error,
  contextNote,
  onClose,
  onConfirm,
  onSubmitPublicForm,
  onSubmitSecureInput,
  onContinueOAuth,
  onOpenApproval,
  renderApprovalAction,
  onReviewArtifacts,
  onOpenNativePathPicker,
}: ChatChangePlanActionDialogProps) {
  const [bodyReady, setBodyReady] = useState(false);
  const [failedBodyKey, setFailedBodyKey] = useState<string | null>(null);
  const loadingFocus = useRef<HTMLParagraphElement>(null);
  const waitingForBodyFocus = useRef(false);
  const loadingFocusIntent = useRef(false);
  const action = plan?.requiredAction;
  const actionKey = action ? `${plan.planId}:${plan.revision}:${action.actionId}` : "closed";
  const bodyFailed = failedBodyKey === actionKey;
  useLayoutEffect(() => {
    if (!plan || !action || bodyReady || bodyFailed || typeof document === "undefined") return;
    const markIntent = () => {
      if (waitingForBodyFocus.current) loadingFocusIntent.current = true;
    };
    document.addEventListener("keydown", markIntent, true);
    document.addEventListener("pointerdown", markIntent, true);
    document.addEventListener("pointermove", markIntent, true);
    return () => {
      document.removeEventListener("keydown", markIntent, true);
      document.removeEventListener("pointerdown", markIntent, true);
      document.removeEventListener("pointermove", markIntent, true);
    };
  }, [plan, action, bodyReady, bodyFailed]);
  const handleOpenAutoFocus = useCallback(
    (event: Event) => {
      const sentinel = loadingFocus.current;
      if (bodyReady || bodyFailed || !sentinel) return;
      event.preventDefault();
      loadingFocusIntent.current = false;
      waitingForBodyFocus.current = true;
      sentinel.focus({ preventScroll: true });
    },
    [bodyReady, bodyFailed],
  );
  const handleBodyReady = useCallback(() => {
    const sentinel = loadingFocus.current;
    if (
      waitingForBodyFocus.current &&
      !loadingFocusIntent.current &&
      sentinel &&
      sentinel.ownerDocument.activeElement === sentinel
    ) {
      const dialog = sentinel.closest<HTMLElement>('[role="dialog"]');
      const first = dialog
        ? [...dialog.querySelectorAll<HTMLElement>("input,select,textarea,button,a[href],summary,[tabindex]")].find(
            (element) =>
              element.tabIndex >= 0 &&
              !element.matches(":disabled") &&
              !element.closest("[hidden]") &&
              !(element instanceof HTMLInputElement && element.type === "hidden") &&
              getComputedStyle(element).display !== "none" &&
              getComputedStyle(element).visibility !== "hidden",
          )
        : undefined;
      first?.focus({ preventScroll: true });
    }
    waitingForBodyFocus.current = false;
    setBodyReady(true);
  }, []);
  const handleBodyError = useCallback(() => {
    waitingForBodyFocus.current = false;
    setFailedBodyKey(actionKey);
    setBodyReady(false);
  }, [actionKey]);

  const publicFormFields = action?.kind === "public_form" ? action.fields : undefined;
  const [values, setValues] = useState<Record<string, string | number | boolean>>({});
  const [secureValues, setSecureValues] = useState<Record<string, string>>({});
  const [artifactReview, setArtifactReview] = useState<{
    key: string;
    data?: CandidateSkillArtifactReview;
    error?: string;
  } | null>(null);
  const needsCandidatePreview = action?.kind === "artifact_review" && plan?.request.kind === "capability_candidate";
  useEffect(() => {
    if (
      !needsCandidatePreview ||
      !plan ||
      action?.kind !== "artifact_review" ||
      plan.request.kind !== "capability_candidate"
    )
      return;
    let cancelled = false;
    const request = plan.request;
    void (async () => {
      const candidate = await fetchCapabilityCandidate(plan.target.resourceId);
      const versionId = request.versionId ?? candidate.latestVersion?.versionId;
      if (!versionId) throw new Error("The candidate version is unavailable.");
      const data = await fetchCandidateSkillArtifactReview(candidate.candidateId, versionId, plan.origin.workspaceId);
      const refs = data.artifacts.map((item) => item.artifactRef).sort();
      if (
        data.revision !== plan.target.expectedRevision ||
        JSON.stringify(refs) !== JSON.stringify([...action.artifactRefs].sort())
      ) {
        throw new Error("The reviewed artifacts changed. Reopen a current activation plan.");
      }
      if (!cancelled) setArtifactReview({ key: actionKey, data });
    })().catch((failure) => {
      if (!cancelled)
        setArtifactReview({
          key: actionKey,
          error: failure instanceof Error ? failure.message : "Artifact preview failed.",
        });
    });
    return () => {
      cancelled = true;
    };
  }, [actionKey, needsCandidatePreview, plan, action]);
  const previewReady = !needsCandidatePreview || (artifactReview?.key === actionKey && Boolean(artifactReview.data));

  useEffect(() => {
    setValues(
      publicFormFields
        ? Object.fromEntries(
            publicFormFields.flatMap((field) =>
              field.initialValue === undefined ? [] : [[field.fieldId, field.initialValue]],
            ),
          )
        : {},
    );
    setSecureValues({});
  }, [actionKey, publicFormFields]);

  const missingRequired = useMemo(() => {
    if (action?.kind !== "public_form") return false;
    return action.fields.some((field) => field.required && isMissing(field, values[field.fieldId]));
  }, [action, values]);

  if (!plan || !action) return null;

  const submit = async () => {
    if (!previewReady || !bodyReady) return;
    switch (action.kind) {
      case "confirmation":
        await onConfirm(plan);
        return;
      case "public_form":
        await onSubmitPublicForm(plan, values);
        return;
      case "secure_input": {
        const submittedValues = { ...secureValues };
        setSecureValues({});
        await onSubmitSecureInput(plan, submittedValues);
        return;
      }
      case "oauth":
        await onContinueOAuth(plan);
        return;
      case "approval":
        if (!renderApprovalAction) await onOpenApproval?.(plan);
        return;
      case "artifact_review":
        await onReviewArtifacts(plan);
        return;
      case "native_path_picker":
        await onOpenNativePathPicker(plan);
        return;
    }
  };

  return (
    <GCModal
      className="chat-change-plan-modal"
      onOpenAutoFocus={handleOpenAutoFocus}
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      title={linkedPlan ? "Apply model to this Chat and future Chats?" : action.title}
      description={[dialogDescription(plan, action), linkedPlan ? linkedPlan.summary : undefined, contextNote]
        .filter(Boolean)
        .join("\n\n")}
      confirmLabel={linkedPlan ? "Apply both exact changes" : confirmLabel(action)}
      danger={plan.risk === "danger" || linkedPlan?.risk === "danger"}
      confirmPending={pending || waiting}
      confirmDisabled={
        !bodyReady ||
        !previewReady ||
        missingRequired ||
        (action.kind === "secure_input" &&
          secureFields(action).some((field) => field.required !== false && !secureValues[field.fieldId]?.trim())) ||
        (action.kind === "secure_input" && !Object.values(secureValues).some((value) => value.trim().length > 0)) ||
        Boolean(linkedPlan && linkedPlan.requiredAction?.kind !== "confirmation")
      }
      dismissDisabled={pending}
      onConfirm={action.kind === "approval" && (renderApprovalAction || !onOpenApproval) ? undefined : submit}
    >
      {!bodyReady && !bodyFailed ? (
        <p ref={loadingFocus} tabIndex={-1} aria-busy="true">
          Opening setup review…
        </p>
      ) : null}
      <PageErrorBoundary pageLabel="Setup review" resetKey={actionKey} onError={handleBodyError}>
        <Suspense fallback={null}>
          <ChatChangePlanActionDialogBody
            plan={plan}
            action={action}
            linkedPlan={linkedPlan}
            pending={pending}
            error={error}
            values={values}
            setValues={setValues}
            secureValues={secureValues}
            setSecureValues={setSecureValues}
            artifactKey={artifactReview?.key}
            artifactItems={artifactReview?.data?.artifacts}
            artifactError={artifactReview?.error}
            hasArtifactData={Boolean(artifactReview?.data)}
            needsCandidatePreview={needsCandidatePreview}
            actionKey={actionKey}
            renderApprovalAction={renderApprovalAction}
            onReady={handleBodyReady}
          />
        </Suspense>
      </PageErrorBoundary>
    </GCModal>
  );
}

function isMissing(field: ChangePlanPublicFormField, value: string | number | boolean | undefined): boolean {
  if (field.type === "boolean") return value !== true;
  if (field.type === "number") return typeof value !== "number" || !Number.isFinite(value);
  return typeof value !== "string" || value.trim().length === 0;
}

function confirmLabel(action: ChangePlanRequiredAction): string {
  switch (action.kind) {
    case "public_form":
      return action.submitLabel ?? "Submit details";
    case "secure_input":
      return "Submit securely";
    case "oauth":
      return "Continue to OAuth";
    case "native_path_picker":
      return "Open native picker";
    case "approval":
      return "Open or resume approval";
    case "artifact_review":
      return "Artifacts reviewed";
    case "confirmation":
      return action.purpose === "rollback" ? "Confirm rollback" : "Apply exact change";
  }
}

function dialogDescription(plan: ChangePlanRecord, action: ChangePlanRequiredAction): string {
  if (action.kind === "confirmation") {
    return action.purpose === "rollback" ? action.confirmationText : `${action.confirmationText}\n\n${plan.impact}`;
  }
  return `${plan.summary} ${plan.impact}`;
}
