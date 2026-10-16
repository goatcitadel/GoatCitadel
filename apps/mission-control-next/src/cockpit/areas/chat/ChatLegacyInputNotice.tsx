import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import {
  getGatewayAccessRevision,
  getGatewayCallerScope,
  getGatewayCallerScopeRevision,
  subscribeGatewayAccessChange,
  subscribeGatewayCallerScope,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";

type Review = { scope: object; key: string; text: string };
/** Legacy bytes stay unowned. Only an explicit reviewed text copy enters the current draft owner. */
export function ChatLegacyInputNotice({
  workspaceId,
  sessionId,
  draft,
  onRestore,
  disabled = false,
}: {
  workspaceId?: string;
  sessionId: string | null;
  draft: string;
  onRestore: (text: string) => void;
  disabled?: boolean;
}) {
  const caller = useSyncExternalStore(subscribeGatewayCallerScope, getGatewayCallerScope, getGatewayCallerScope);
  const callerRevision = useSyncExternalStore(
    subscribeGatewayCallerScope,
    getGatewayCallerScopeRevision,
    getGatewayCallerScopeRevision,
  );
  const access = useSyncExternalStore(subscribeGatewayAccessChange, getGatewayAccessRevision, getGatewayAccessRevision);
  const gateway = getGatewayApiBaseUrl();
  const identity = JSON.stringify([gateway, caller, callerRevision, access, workspaceId, sessionId]);
  const owner = useRef({ identity });
  if (owner.current.identity !== identity) owner.current = { identity };
  const scope = owner.current;
  const mounted = useRef(true);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const pending = useRef<{ scope: object } | null>(null);
  const reviewTrigger = useRef<HTMLButtonElement>(null);
  const cancelledFocusScope = useRef<object | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current = null;
      cancelledFocusScope.current = null;
    };
  }, []);
  const current = useCallback(
    () =>
      mounted.current &&
      owner.current === scope &&
      getGatewayCallerScope() === caller &&
      getGatewayCallerScopeRevision() === callerRevision &&
      getGatewayAccessRevision() === access &&
      getGatewayApiBaseUrl() === gateway,
    [scope, caller, callerRevision, access, gateway],
  );
  const [review, setReview] = useState<Review | null>(null);
  const [recognized, setRecognized] = useState(false);
  const [checkingScope, setCheckingScope] = useState<object | null>(null);
  const [notice, setNotice] = useState<{ scope: object; text: string } | null>(null);
  const checking = checkingScope === scope;
  useLayoutEffect(() => {
    const requestedScope = cancelledFocusScope.current;
    if (checking || !requestedScope) return;
    cancelledFocusScope.current = null;
    if (requestedScope === scope && current() && !disabledRef.current)
      reviewTrigger.current?.focus({ preventScroll: true });
  }, [checking, scope, current]);
  const key = `goatcitadel.chat.draft.${workspaceId}.${sessionId ?? "new"}`;
  let retained = false;
  try {
    retained = Boolean(caller && workspaceId && window.localStorage.getItem(key));
  } catch {
    /* Storage unavailable: intentionally treated as no retained draft. */
  }
  const begin = async () => {
    if (!current() || !caller || !workspaceId || disabledRef.current || pending.current?.scope === scope) return;
    const request = { scope };
    pending.current = request;
    const ownsReview = () => pending.current === request && current() && !disabledRef.current;
    setReview(null);
    setRecognized(false);
    setNotice(null);
    setCheckingScope(scope);
    const rejected = () =>
      setNotice({
        scope,
        text: "This saved input cannot be recovered here because it exceeds the draft limit or contains sensitive or structured content. Its original bytes remain unchanged.",
      });
    try {
      const text = window.localStorage.getItem(key);
      if (!text?.trim() || !ownsReview()) return;
      if (text.length > 64 * 1024 || /<workflow_evidence[>\s]/i.test(text)) {
        rejected();
        return;
      }
      // Load the existing validator only on an explicit review; unvalidated bytes never reach a view.
      const { redactSecretText } = await import("@goatcitadel/contracts/secret-redaction");
      if (!ownsReview()) return;
      const latest = window.localStorage.getItem(key);
      if (!ownsReview()) return;
      if (latest !== text) {
        setNotice({ scope, text: "The saved input changed. Review it again before restoring." });
        return;
      }
      if (redactSecretText(text).redactionCount > 0) {
        rejected();
        return;
      }
      if (ownsReview()) setReview({ scope, key, text });
    } catch {
      if (ownsReview())
        setNotice({ scope, text: "Saved input could not be checked. Try reviewing it again. Nothing was restored." });
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setCheckingScope(null);
      }
    }
  };
  const cancelCheck = () => {
    if (pending.current?.scope !== scope) return;
    cancelledFocusScope.current = scope;
    pending.current = null;
    setCheckingScope(null);
    setNotice(null);
  };
  const restore = () => {
    if (!current() || !review || review.scope !== scope || !recognized || draft.length > 0 || disabledRef.current)
      return;
    try {
      if (window.localStorage.getItem(review.key) !== review.text) {
        setReview(null);
        setNotice({ scope, text: "The saved input changed. Review it again before restoring." });
        return;
      }
      if (!current()) return;
      onRestore(review.text);
      setReview(null);
      setNotice({
        scope,
        text: "Reviewed text restored to this conversation's draft. Nothing was sent; the original saved input is unchanged.",
      });
    } catch {
      setNotice({ scope, text: "Saved input could not be reread. Nothing was restored." });
    }
  };
  return retained || checking || notice?.scope === scope ? (
    <div className="mt-2 text-xs text-fg-secondary">
      {retained ? (
        <>
          <p>You have an unsent draft from an earlier session. It has not been added here; review it first.</p>
          <Button
            ref={reviewTrigger}
            size="sm"
            onClick={() => {
              void begin();
            }}
            disabled={disabled || checking}
          >
            Review older saved text
          </Button>
        </>
      ) : null}
      {checking ? (
        <>
          <p role="status">Checking saved input…</p>
          <Button size="sm" onClick={cancelCheck}>
            Cancel review
          </Button>
        </>
      ) : null}
      {notice?.scope === scope ? <p role="status">{notice.text}</p> : null}
      <Dialog
        open={review?.scope === scope}
        onOpenChange={(open) => {
          if (!open) setReview(null);
        }}
        title="Review older saved text"
        description="Only restore text you recognize as yours. Attachments and queued messages are excluded. This copies text into the current conversation draft and does not send it or alter the original saved input."
      >
        <label className="block text-sm">
          Saved text
          <textarea
            readOnly
            rows={6}
            value={review?.scope === scope ? review.text : ""}
            className="mt-1 block w-full rounded-md border border-line-control bg-canvas p-2 text-fg"
          />
        </label>
        <label className="my-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={recognized} onChange={(event) => setRecognized(event.target.checked)} />I
          recognize this text and want it in this conversation
        </label>
        {draft.length > 0 ? (
          <p>Your current draft must be empty before restoring. Cancel to keep working on it.</p>
        ) : null}
        <div className="mt-3 flex justify-end gap-2">
          <Button onClick={() => setReview(null)}>Cancel</Button>
          <Button onClick={restore} disabled={!recognized || draft.length > 0 || disabled}>
            Restore reviewed text
          </Button>
        </div>
      </Dialog>
    </div>
  ) : null;
}
