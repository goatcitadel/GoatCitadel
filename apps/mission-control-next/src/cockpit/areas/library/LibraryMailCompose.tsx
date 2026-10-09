import { useState } from "react";
import type { MailAccountRecord, MailDraftRecord } from "@goatcitadel/contracts";
import { createMailDraft, sendMailDraft } from "@goatcitadel/mission-control-shared/api/personal-ops";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useSessionViewState } from "../../../hooks/use-session-view-state";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Dialog } from "../../ui/Dialog";
import { Field } from "../../ui/Field";
import { RiskBadge } from "../../ui/RiskBadge";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { handleEvidenceScrollKeyDown } from "../../ui/evidence-scroll";
import { LibraryApproval } from "./LibraryApproval";
import { useLibraryOperation } from "./use-library-operation";
import {
  draftMatchesRequest,
  EMPTY_MAIL_COMPOSE,
  validateMailCompose,
  type MailCompose,
  type MailComposeErrors,
} from "./mail-draft";

type Props = {
  workspaceId: string;
  /** Undefined until the Gateway has answered; never shown as "no account". */
  accounts: MailAccountRecord[] | undefined;
  available: boolean;
  onRefresh: () => Promise<unknown>;
  /** The communications read failed before any accounts were known. */
  loadFailed?: boolean;
};
type AccountView = { label: string; address?: string; syncStatus: MailAccountRecord["syncStatus"] };
/** The exact Gateway draft under review, with the compose value and account it was prepared from. */
type SendReview = { record: MailDraftRecord; compose: MailCompose; account: AccountView };
type Outcome = { error: boolean; text: string };
/** `replayed` marks a receipt for a request whose original response was lost. */
type SendReceipt = { record: MailDraftRecord; replayed: boolean };
const NO_ACCOUNTS: MailAccountRecord[] = [];

const INPUT = "w-full min-w-0 rounded-md border border-line bg-raised p-2";

export function LibraryMailCompose(props: Props) {
  const access = useLibraryOperation(JSON.stringify(["communications-send", props.workspaceId]));
  return <LibraryMailComposeContent key={access.identity} {...props} />;
}

function LibraryMailComposeContent({
  workspaceId,
  accounts: knownAccounts,
  available: loaded,
  onRefresh,
  loadFailed = false,
}: Props) {
  const accounts = knownAccounts ?? NO_ACCOUNTS;
  const available = loaded && Boolean(knownAccounts);
  const operation = useLibraryOperation(JSON.stringify(["communications-send", workspaceId]));
  const draft = useSessionDraft(operation.presentationScope, EMPTY_MAIL_COMPOSE, undefined, { label: "Email draft" });
  const [review, setReview] = useSessionViewState<SendReview | undefined>(operation.key + ":review", undefined);
  // The owner request outlives its dialog so a lost response can only be replayed exactly.
  const [pending, setPending] = useSessionViewState<SendReview | undefined>(operation.key + ":pending-send", undefined);
  const [receipt, setReceipt] = useSessionViewState<SendReceipt | undefined>(operation.key + ":receipt", undefined);
  const [outcome, setOutcome] = useSessionViewState<Outcome | undefined>(operation.key + ":outcome", undefined);
  const [errors, setErrors] = useState<MailComposeErrors>({});
  const [busy, setBusy] = useState(false);
  const accountId = draft.value.accountId || (accounts.length === 1 ? accounts[0]!.accountId : "");
  const set = (field: keyof MailCompose, value: string) =>
    draft.setValue((current) => ({ ...current, [field]: value }));

  async function prepare() {
    if (busy || operation.locked || !available || !operation.current()) return;
    // Keep the stored value unchanged so a later save acceptance compares like with like.
    const compose = draft.value;
    const parsed = validateMailCompose({ ...compose, accountId }, accounts);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    const account = accounts.find((item) => item.accountId === accountId)!;
    setErrors({});
    setOutcome(undefined);
    setBusy(true);
    try {
      const record = await createMailDraft({ workspaceId, ...parsed.request });
      if (!operation.current()) return;
      if (record.status !== "draft" || !draftMatchesRequest(record, parsed.request, workspaceId))
        throw new Error("The Gateway draft does not match what you entered.");
      setReview({
        record,
        compose,
        account: { label: account.label, address: account.address, syncStatus: account.syncStatus },
      });
    } catch (cause) {
      if (operation.current())
        setOutcome({ error: true, text: `${describeApiError(cause).summary} No send approval was requested.` });
    } finally {
      if (operation.current()) setBusy(false);
    }
  }

  async function requestSend(replay = false) {
    const target = review;
    if (!target || busy || !available || !operation.current()) return;
    if (
      replay
        ? pending?.record.draftId !== target.record.draftId || operation.attempt?.phase !== "uncertain"
        : operation.locked
    )
      return;
    setBusy(true);
    setOutcome(undefined);
    let dispatched = false;
    try {
      const result = await operation.run(
        "send:" + target.record.draftId,
        async () => undefined,
        async () => {
          dispatched = true;
          if (!replay) setPending(target);
          return sendMailDraft(target.record.draftId);
        },
        (value) => {
          if (value.draftId !== target.record.draftId) throw new Error("The send receipt names a different draft.");
          if (
            value.status === "approval_required" &&
            (!value.approvalId || !draftMatchesRequest(value, target.record, workspaceId))
          )
            throw new Error("The send approval receipt does not match the reviewed draft.");
          if (value.status !== "approval_required" && value.status !== "failed")
            throw new Error("The Gateway returned an unexpected draft status.");
        },
        replay,
      );
      if (!result || !operation.current()) return;
      setPending(undefined);
      setReview(undefined);
      setReceipt({ record: result, replayed: replay });
      if (result.status === "approval_required") draft.acceptSaved(EMPTY_MAIL_COMPOSE, undefined, target.compose);
      await onRefresh();
    } catch (cause) {
      if (operation.current())
        setOutcome({
          error: true,
          text: dispatched
            ? `${describeApiError(cause).summary} Whether a send approval was recorded is not confirmed. Check Inbox before requesting again.`
            : describeApiError(cause).summary,
        });
    } finally {
      if (operation.current()) setBusy(false);
    }
  }

  function close() {
    if (busy) return;
    const cancelled = !pending || pending.record.draftId !== review?.record.draftId;
    setReview(undefined);
    if (cancelled)
      setOutcome({
        error: false,
        text: "Cancelled. No send approval was requested. The prepared draft stays inert in Gateway memory.",
      });
  }

  const reviewed = review?.record;
  const canReplay = Boolean(
    reviewed && pending?.record.draftId === reviewed.draftId && operation.attempt?.phase === "uncertain",
  );
  return (
    <section className="grid min-w-0 grid-cols-1 gap-3 rounded-lg border border-line p-3" aria-label="Compose email">
      <h2 className="font-display text-lg text-fg">Compose email</h2>
      <p className="text-sm text-fg-secondary">
        What you type stays in this browser session. Review stores the draft, including Bcc, in Gateway memory until the
        Gateway restarts. Only Request send approval asks for an approval, and approval records your intent only:
        GoatCitadel does not send mail from here.
      </p>
      {!knownAccounts ? (
        <p role="status">
          {loadFailed
            ? "Mail accounts could not be read. Refresh communications to try again."
            : "Reading mail accounts…"}
        </p>
      ) : null}
      {knownAccounts && !accounts.length ? (
        <Callout tone="warning">
          No mail account is connected to this workspace. Connect a mail integration before drafting.
        </Callout>
      ) : null}
      {operation.locked ? <Callout tone="warning">{operation.attempt?.message}</Callout> : null}
      {operation.locked && pending ? (
        <Button
          onClick={() => {
            setOutcome(undefined);
            setReview(pending);
          }}
        >
          Review pending send request
        </Button>
      ) : null}
      {accounts.length > 1 ? (
        <Field label="Mail account" error={errors.accountId}>
          {(props) => (
            <select
              {...props}
              className={INPUT}
              value={accountId}
              onChange={(event) => set("accountId", event.target.value)}
            >
              <option value="">Choose an account</option>
              {accounts.map((item) => (
                <option key={item.accountId} value={item.accountId}>
                  {item.label}
                  {item.address ? ` · ${item.address}` : ""}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : accounts[0] ? (
        <p className="text-sm">
          From {accounts[0].label}
          {accounts[0].address ? ` · ${accounts[0].address}` : ""}
        </p>
      ) : null}
      {accounts.length <= 1 && errors.accountId ? (
        <p role="alert" className="text-sm">
          {errors.accountId}
        </p>
      ) : null}
      <Field label="To" help="Separate addresses with commas or semicolons." error={errors.to}>
        {(props) => (
          <input
            {...props}
            className={INPUT}
            autoComplete="off"
            value={draft.value.to}
            onChange={(event) => set("to", event.target.value)}
          />
        )}
      </Field>
      <Field label="Cc" error={errors.cc}>
        {(props) => (
          <input
            {...props}
            className={INPUT}
            autoComplete="off"
            value={draft.value.cc}
            onChange={(event) => set("cc", event.target.value)}
          />
        )}
      </Field>
      <Field label="Bcc" error={errors.bcc}>
        {(props) => (
          <input
            {...props}
            className={INPUT}
            autoComplete="off"
            value={draft.value.bcc}
            onChange={(event) => set("bcc", event.target.value)}
          />
        )}
      </Field>
      <Field label="Subject" error={errors.subject}>
        {(props) => (
          <input
            {...props}
            className={INPUT}
            value={draft.value.subject}
            onChange={(event) => set("subject", event.target.value)}
          />
        )}
      </Field>
      <Field label="Message" error={errors.bodyText}>
        {(props) => (
          <textarea
            {...props}
            className={INPUT}
            rows={6}
            value={draft.value.bodyText}
            onChange={(event) => set("bodyText", event.target.value)}
          />
        )}
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={busy || operation.locked || !available || !accounts.length}
          onClick={() => void prepare()}
        >
          Review send request
        </Button>
        <Button variant="ghost" disabled={busy || !draft.isDirty} onClick={draft.discard}>
          Discard email draft
        </Button>
      </div>
      {outcome && !review ? <Callout tone={outcome.error ? "error" : "info"}>{outcome.text}</Callout> : null}
      {receipt ? (
        <section className="grid min-w-0 grid-cols-1 gap-2" aria-label="Send approval receipt">
          {receipt.record.status === "approval_required" && receipt.record.approvalId ? (
            <>
              <Callout>
                Send approval requested. Nothing has been sent. Approving records operator intent only; this Gateway
                route never delivers mail.
              </Callout>
              <p className="wrap-anywhere text-sm">
                To {receipt.record.to.join(", ")} · {receipt.record.subject}
              </p>
              <LibraryApproval approvalId={receipt.record.approvalId} workspaceId={workspaceId} onRefresh={onRefresh} />
            </>
          ) : receipt.replayed ? (
            <Callout tone="error">
              The earlier send request&apos;s outcome is unknown: a send approval may already exist, and this draft can
              no longer be sent. Nothing was sent. Check Inbox before preparing a new request.
            </Callout>
          ) : (
            <Callout tone="error">
              The Gateway cannot request an approval for this draft: it no longer holds it (drafts live in Gateway
              memory until it restarts), or an earlier request for it ended without a confirmed outcome. Nothing was
              sent. Check Inbox, then review the send request again to prepare a new draft.
            </Callout>
          )}
          <Button variant="ghost" onClick={() => setReceipt(undefined)}>
            Dismiss send receipt
          </Button>
        </section>
      ) : null}
      <Dialog
        open={Boolean(reviewed)}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        title="Review send request"
        description="Check every recipient and the exact text. The Gateway records the approval request for this draft only."
      >
        {reviewed && review ? (
          <div className="grid min-w-0 grid-cols-1 gap-3 text-sm wrap-anywhere">
            <dl className="grid min-w-0 grid-cols-1 gap-2">
              <div>
                <dt className="font-medium">From</dt>
                <dd>
                  {review.account.label}
                  {review.account.address ? ` · ${review.account.address}` : ""} · account status{" "}
                  {review.account.syncStatus.replaceAll("_", " ")}
                </dd>
              </div>
              <div>
                <dt className="font-medium">To</dt>
                <dd>{reviewed.to.join(", ")}</dd>
              </div>
              <div>
                <dt className="font-medium">Cc</dt>
                <dd>{reviewed.cc.length ? reviewed.cc.join(", ") : "None"}</dd>
              </div>
              <div>
                <dt className="font-medium">Bcc</dt>
                <dd>{reviewed.bcc.length ? reviewed.bcc.join(", ") : "None"}</dd>
              </div>
              <div>
                <dt className="font-medium">Subject</dt>
                <dd>{reviewed.subject}</dd>
              </div>
              <div>
                <dt className="font-medium">Attachments and context</dt>
                <dd>No attachments. Only the text below is included; no files or conversation context are attached.</dd>
              </div>
              <div>
                <dt className="font-medium">Scope</dt>
                <dd>Workspace {workspaceId}</dd>
              </div>
            </dl>
            <pre
              role="region"
              aria-label="Exact message text"
              tabIndex={0}
              onKeyDown={handleEvidenceScrollKeyDown}
              className="max-h-48 min-w-0 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-sunken p-2 font-sans wrap-anywhere focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              {reviewed.bodyText}
            </pre>
            <div className="flex flex-wrap items-center gap-2">
              <RiskBadge risk="danger" />
              <span>Requests one high-risk approval to send this exact draft.</span>
            </div>
            <p>
              Approving records operator intent only: GoatCitadel does not send this message. Delivery is never
              confirmed here.
            </p>
            <TechnicalDetails label="Draft record">
              <p>Draft {reviewed.draftId}</p>
            </TechnicalDetails>
            {outcome ? <Callout tone={outcome.error ? "error" : "info"}>{outcome.text}</Callout> : null}
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" disabled={busy} onClick={close}>
                {canReplay ? "Close" : "Cancel"}
              </Button>
              {canReplay ? (
                <Button disabled={busy || !available} onClick={() => void requestSend(true)}>
                  Replay exact send request
                </Button>
              ) : (
                <Button
                  variant="danger"
                  disabled={busy || operation.locked || !available}
                  onClick={() => void requestSend()}
                >
                  Request send approval
                </Button>
              )}
            </div>
          </div>
        ) : null}
      </Dialog>
    </section>
  );
}
