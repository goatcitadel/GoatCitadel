import { useRef, useState } from "react";
import type { SessionControlDetailResponse, SessionControlRequestRecord } from "@goatcitadel/contracts";
import {
  fetchSessionControlDetail,
  handoffSessionControl,
  revokeSessionControl,
} from "@goatcitadel/mission-control-shared/api/session-control-operator";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { useSessionControlStatus } from "@goatcitadel/mission-control-shared/hooks/useSessionControlStatus";
import { deriveSessionControlBannerViewModel } from "@goatcitadel/threaded-surface-core";
import { Button } from "../../ui/Button";
import { TimeText } from "../../ui/TimeText";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { useProjectAccess } from "@goatcitadel/mission-control-shared/hooks/use-current-access";

type Review =
  | { kind: "handoff"; request: SessionControlRequestRecord; read: boolean }
  | { kind: "revoke" | "emergency_takeover"; generation: number; client: string };
/** One exact owner request; a retry resends it unchanged so the Gateway applies it at most once. */
type Attempt = { review: Review; idempotencyKey: string };

const newKey = () => `op-ctl-${crypto.randomUUID()}`;
/** A Gateway conflict is a definitive refusal (the generation compare-and-set failed): nothing was applied. */
const refused = (error: unknown) => isApiRequestError(error) && error.status === 409;
const CHANGED = "GoatCitadel refused this because control changed, so nothing was applied. Review the current state.";
const UNKNOWN =
  "The outcome is unknown. The current state was read again. Retry sends the identical request, which GoatCitadel applies at most once.";
const time = (value?: string) =>
  value && Number.isFinite(Date.parse(value)) ? <TimeText value={value} /> : "Not reported";

/** The reviewed transition still applies to the freshly read state. */
function stillCurrent(review: Review, detail: SessionControlDetailResponse) {
  if (review.kind === "handoff")
    return (
      detail.control.ownerKind === "operator" &&
      detail.control.generation === review.request.requestedGeneration &&
      detail.pendingRequests.some((item) => item.requestId === review.request.requestId)
    );
  return detail.control.ownerKind !== "operator" && detail.control.generation === review.generation;
}

function dispatch(sessionId: string, attempt: Attempt) {
  const { review, idempotencyKey } = attempt;
  if (review.kind === "handoff")
    return handoffSessionControl(sessionId, {
      requestId: review.request.requestId,
      expectedGeneration: review.request.requestedGeneration,
      effectiveCapabilities: review.read ? ["send", "read"] : ["send"],
      idempotencyKey,
    });
  return revokeSessionControl(sessionId, {
    target: "current_controller",
    expectedGeneration: review.generation,
    mode: review.kind,
    idempotencyKey,
  });
}

const DONE: Record<Review["kind"], string> = {
  handoff: "Control was handed off. The current state was read again.",
  revoke: "External control was revoked. The current state was read again.",
  emergency_takeover: "You took over this conversation. The current state was read again.",
};

function reviewCopy(review: Review | null) {
  if (!review) return { title: "", message: "", confirm: "" };
  if (review.kind === "handoff")
    return {
      title: "Hand off control of this conversation?",
      confirm: "Hand off control",
      message: `Give control of this conversation to the companion client with ${
        review.read ? "Send and Read" : "Send only"
      }. Your own messages stay blocked until you revoke or take over. The control state is re-read first; if it changed, nothing is sent.`,
    };
  if (review.kind === "revoke")
    return {
      title: "Revoke external control?",
      confirm: "Revoke control",
      message: `End ${review.client}'s control (generation ${review.generation}). It loses send access and control returns to you. The control state is re-read first; if it changed, nothing is sent.`,
    };
  return {
    title: "Take over this conversation now?",
    confirm: "Take over now",
    message: `Take control from ${review.client} (generation ${review.generation}). The external client loses control immediately, and anything it sends with its old generation is refused. Use this when it is unresponsive or untrusted. The control state is re-read first; if it changed, nothing is sent.`,
  };
}

/**
 * Operator session control for one Chat conversation: pending external requests (hand off or reject) and the current
 * external controller (revoke or emergency takeover). Every consequential action is reviewed, re-reads the canonical
 * control state, and is bound to the reviewed generation; the Gateway enforces the same compare-and-set.
 */
export function SessionControlManager({ sessionId, workspaceId }: { sessionId: string; workspaceId?: string }) {
  const access = useProjectAccess(JSON.stringify(["session-control", workspaceId, sessionId]));
  return (
    <SelectedSessionControlManager
      key={access.identity}
      sessionId={sessionId}
      workspaceId={workspaceId}
      access={access}
    />
  );
}

function SelectedSessionControlManager({
  sessionId,
  workspaceId,
  access,
}: {
  sessionId: string;
  workspaceId?: string;
  access: ReturnType<typeof useProjectAccess>;
}) {
  const status = useSessionControlStatus(sessionId);
  const [grantRead, setGrantRead] = useState<Record<string, boolean>>({});
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState<Attempt | null>(null);
  const running = useRef(false);
  const matchesSelection = (value: SessionControlDetailResponse) =>
    value.control.sessionId === sessionId.trim() &&
    (workspaceId === undefined || value.control.workspaceId === workspaceId);
  const detail = status.data && matchesSelection(status.data) ? status.data : null;
  const scopeMismatch = Boolean(status.data && !detail);
  const model = deriveSessionControlBannerViewModel(detail);
  const pending = detail && detail.control.ownerKind === "operator" ? detail.pendingRequests : [];

  async function run(action: () => Promise<string>) {
    if (running.current || !access.current()) return;
    running.current = true;
    setBusy(true);
    setNotice("");
    try {
      const message = await action();
      if (access.current()) setNotice(message);
    } finally {
      if (access.current()) await status.reload();
      running.current = false;
      if (access.current()) setBusy(false);
    }
  }

  const send = (attempt: Attempt) =>
    run(async () => {
      setRetry(null);
      try {
        await dispatch(sessionId, attempt);
        return DONE[attempt.review.kind];
      } catch (error) {
        if (refused(error)) return CHANGED;
        if (access.current()) setRetry(attempt);
        return UNKNOWN;
      }
    });

  const confirm = (reviewed: Review) =>
    run(async () => {
      setReview(null);
      let current: SessionControlDetailResponse;
      try {
        current = await fetchSessionControlDetail(sessionId);
      } catch {
        return "The control state could not be re-read, so nothing was sent.";
      }
      if (!access.current()) return "The selected session or access changed, so nothing was sent.";
      if (!matchesSelection(current))
        return "The control state does not match this session and workspace, so nothing was sent.";
      if (!stillCurrent(reviewed, current))
        return "Control of this conversation changed since your review, so nothing was sent. Review the current state.";
      const attempt = { review: reviewed, idempotencyKey: newKey() };
      setRetry(null);
      try {
        await dispatch(sessionId, attempt);
        return DONE[reviewed.kind];
      } catch (error) {
        if (refused(error)) return CHANGED;
        if (access.current()) setRetry(attempt);
        return UNKNOWN;
      }
    });

  const reject = (request: SessionControlRequestRecord) =>
    run(async () => {
      try {
        await revokeSessionControl(sessionId, {
          target: "request",
          requestId: request.requestId,
          idempotencyKey: newKey(),
        });
        return "The request was rejected. The current state was read again.";
      } catch {
        return "The rejection was not confirmed. The current state was read again; check the request before acting.";
      }
    });

  const copy = reviewCopy(review);
  return (
    <section aria-labelledby="session-control-title" className="space-y-3 rounded-md border border-line p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 id="session-control-title" className="font-semibold text-fg">
          Session control
        </h3>
        <Button size="sm" disabled={busy || status.loading} onClick={() => void status.reload()}>
          {status.loading ? "Reloading control" : "Reload control"}
        </Button>
      </div>
      {scopeMismatch ? (
        <p role="alert" className="text-status-failed">
          This control state does not match the selected session and workspace. No control actions are available.
        </p>
      ) : null}
      {status.error ? (
        <p role="alert" className="text-status-failed">
          {detail ? `${status.error} Showing the last read.` : status.error}
        </p>
      ) : null}
      {status.loading && !detail ? (
        <p role="status" className="text-fg-muted">
          Reading control state…
        </p>
      ) : null}
      {detail && !model.externalControlActive ? <p>You control this conversation · {model.generationLabel}</p> : null}
      {detail && model.externalControlActive ? (
        <div
          role="group"
          aria-label="Current external controller"
          className="space-y-2 rounded-md border border-status-waiting/40 p-3"
        >
          <p className="font-medium text-fg">
            {model.ownerLabel} · {model.leaseStateLabel} · {model.capabilitiesLabel} · {model.generationLabel}
          </p>
          <p>{model.sendLockReason}</p>
          <TechnicalDetails label="Controller identifiers">
            <ul className="space-y-1 break-words font-mono text-xs">
              <li>Client: {model.clientInstanceId}</li>
              <li>Companion: {model.companionSessionId}</li>
              <li>Token fingerprint: {model.tokenFingerprint ? `…${model.tokenFingerprint}` : "Not reported"}</li>
            </ul>
          </TechnicalDetails>
          <ul className="space-y-1 break-words text-fg-secondary">
            <li>Last heartbeat: {time(model.lastHeartbeatAt ?? undefined)}</li>
            <li>Lease expires: {time(model.leaseExpiresAt ?? undefined)}</li>
            <li>Reconnect window: {time(model.reconnectExpiresAt ?? undefined)}</li>
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy || model.generation == null}
              onClick={() =>
                setReview({
                  kind: "revoke",
                  generation: model.generation!,
                  client: "the external client",
                })
              }
            >
              Review revoke
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={busy || model.generation == null}
              onClick={() =>
                setReview({
                  kind: "emergency_takeover",
                  generation: model.generation!,
                  client: "the external client",
                })
              }
            >
              Review emergency takeover
            </Button>
          </div>
        </div>
      ) : null}
      {detail && !model.externalControlActive ? (
        pending.length ? (
          <ul aria-label="Pending control requests" className="space-y-2">
            {pending.map((request, index) => {
              const requestName = pending.length > 1 ? `companion request ${index + 1}` : "the companion request";
              const readRequested = request.requestedCapabilities.length > 1;
              return (
                <li key={request.requestId} className="space-y-2 rounded-md border border-line p-3">
                  <p className="font-medium text-fg">
                    {pending.length > 1 ? `Companion request ${index + 1}` : "Companion request"} · Requested:{" "}
                    {readRequested ? "Send and Read" : "Send"}
                  </p>
                  <TechnicalDetails label="Request identifiers">
                    <ul className="space-y-1 break-words font-mono text-xs">
                      <li>Client: {request.clientInstanceId}</li>
                      <li>Companion: {request.companionSessionId}</li>
                      <li>Token fingerprint: …{request.tokenFingerprint}</li>
                    </ul>
                  </TechnicalDetails>
                  <ul className="space-y-1 break-words text-fg-secondary">
                    <li>Requested: {time(request.createdAt)}</li>
                    <li>Expires: {time(request.expiresAt)}</li>
                  </ul>
                  {readRequested ? (
                    <label className="flex min-h-11 items-center gap-2">
                      <input
                        type="checkbox"
                        checked={grantRead[request.requestId] === true}
                        disabled={busy}
                        onChange={(event) =>
                          setGrantRead((value) => ({ ...value, [request.requestId]: event.target.checked }))
                        }
                      />
                      Also grant read (transcript and event stream)
                    </label>
                  ) : (
                    <p className="text-fg-muted">This client asked for send only; read cannot be granted.</p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={busy}
                      aria-label={`Review handoff for ${requestName}`}
                      onClick={() =>
                        setReview({
                          kind: "handoff",
                          request,
                          read: readRequested && grantRead[request.requestId] === true,
                        })
                      }
                    >
                      Review handoff
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy}
                      aria-label={`Reject ${requestName}`}
                      onClick={() => void reject(request)}
                    >
                      Reject request
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-fg-muted">No external client has asked to control this conversation.</p>
        )
      ) : null}
      {notice ? (
        <p role="status" className="text-fg-secondary">
          {notice}
        </p>
      ) : null}
      {retry ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => void send(retry)}>
            Retry the same request
          </Button>
          <Button size="sm" disabled={busy} onClick={() => setRetry(null)}>
            Dismiss
          </Button>
        </div>
      ) : null}
      <ConfirmModal
        open={Boolean(review)}
        danger={review?.kind !== "handoff"}
        title={copy.title}
        message={copy.message}
        confirmLabel={copy.confirm}
        cancelLabel="Keep current control"
        pending={busy}
        onCancel={() => setReview(null)}
        onConfirm={() => {
          if (review) void confirm(review);
        }}
      />
    </section>
  );
}
