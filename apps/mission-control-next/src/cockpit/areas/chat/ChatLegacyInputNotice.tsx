import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { redactSecretText } from "@goatcitadel/contracts";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { getGatewayAccessRevision, getGatewayCallerScope, subscribeGatewayAccessChange, subscribeGatewayCallerScope } from "@goatcitadel/mission-control-shared/api/access-scope";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";

type Review = { scope: object; key: string; text: string };
/** Legacy bytes stay unowned. Only an explicit reviewed text copy enters the current draft owner. */
export function ChatLegacyInputNotice({ workspaceId, sessionId, draft, onRestore, disabled = false }: {
  workspaceId?: string; sessionId: string | null; draft: string; onRestore: (text: string) => void; disabled?: boolean;
}) {
  const caller = useSyncExternalStore(subscribeGatewayCallerScope, getGatewayCallerScope, getGatewayCallerScope);
  const access = useSyncExternalStore(subscribeGatewayAccessChange, getGatewayAccessRevision, getGatewayAccessRevision);
  const gateway = getGatewayApiBaseUrl();
  const identity = JSON.stringify([gateway, caller, access, workspaceId, sessionId]);
  const owner = useRef({ identity });
  if (owner.current.identity !== identity) owner.current = { identity };
  const scope = owner.current;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = () => mounted.current && owner.current === scope && getGatewayCallerScope() === caller
    && getGatewayAccessRevision() === access && getGatewayApiBaseUrl() === gateway;
  const [review, setReview] = useState<Review | null>(null);
  const [recognized, setRecognized] = useState(false);
  const [notice, setNotice] = useState<{ scope: object; text: string } | null>(null);
  const key = `goatcitadel.chat.draft.${workspaceId}.${sessionId ?? "new"}`;
  let retained = false;
  try { retained = Boolean(caller && workspaceId && window.localStorage.getItem(key)); } catch { /* Storage unavailable: intentionally treated as no retained draft. */ }
  const begin = () => {
    if (!current() || !caller || !workspaceId || disabled) return;
    try {
      const text = window.localStorage.getItem(key);
      if (!text?.trim()) return;
      if (text.length > 64 * 1024 || redactSecretText(text).redactionCount > 0 || /<workflow_evidence[>\s]/i.test(text)) {
        setNotice({ scope, text: "This saved input cannot be recovered here because it exceeds the draft limit or contains sensitive or structured content. Its original bytes remain unchanged." });
        return;
      }
      setRecognized(false); setReview({ scope, key, text });
    } catch { setNotice({ scope, text: "Saved input is unavailable in this host. Nothing was restored." }); }
  };
  const restore = () => {
    if (!current() || !review || review.scope !== scope || !recognized || draft.length > 0 || disabled) return;
    try {
      if (window.localStorage.getItem(review.key) !== review.text) {
        setReview(null); setNotice({ scope, text: "The saved input changed. Review it again before restoring." }); return;
      }
      onRestore(review.text);
      setReview(null); setNotice({ scope, text: "Reviewed text restored to this conversation's draft. Nothing was sent; the original saved input is unchanged." });
    } catch { setNotice({ scope, text: "Saved input could not be reread. Nothing was restored." }); }
  };
  return retained || notice?.scope === scope ? <div className="mt-2 text-xs text-fg-secondary">
    {retained ? <><p>Older text is saved without a verified caller identity. It has not been imported.</p>
      <Button size="sm" onClick={begin} disabled={disabled}>Review older saved text</Button></> : null}
    {notice?.scope === scope ? <p role="status">{notice.text}</p> : null}
    <Dialog open={review?.scope === scope} onOpenChange={(open) => { if (!open) setReview(null); }} title="Review older saved text"
      description="Only restore text you recognize as yours. Attachments and queued messages are excluded. This copies text into the current conversation draft and does not send it or alter the original saved input.">
      <label className="block text-sm">Saved text<textarea readOnly rows={6} value={review?.scope === scope ? review.text : ""} className="mt-1 block w-full rounded-md border border-line bg-canvas p-2 text-fg" /></label>
      <label className="my-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={recognized} onChange={(event) => setRecognized(event.target.checked)} />I recognize this text and want it in this conversation</label>
      {draft.length > 0 ? <p>Your current draft must be empty before restoring. Cancel to keep working on it.</p> : null}
      <div className="mt-3 flex justify-end gap-2"><Button onClick={() => setReview(null)}>Cancel</Button>
        <Button onClick={restore} disabled={!recognized || draft.length > 0 || disabled}>Restore reviewed text</Button></div>
    </Dialog>
  </div> : null;
}
