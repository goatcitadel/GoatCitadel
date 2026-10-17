import type { MailAccountRecord, MailDraftRecord } from "@goatcitadel/contracts";

type Account = { label: string; address?: string; syncStatus: MailAccountRecord["syncStatus"] };

/** The exact sender, recipients, subject and scope of a draft under send review. */
export function LibraryMailReviewFields({ account, record }: { account: Account; record: MailDraftRecord }) {
  return (
    <dl className="grid min-w-0 grid-cols-1 gap-2">
      <div>
        <dt className="font-medium">From</dt>
        <dd>
          {account.label}
          {account.address ? ` · ${account.address}` : ""} · account status{" "}
          {account.syncStatus === "not_configured" ? "not set up" : account.syncStatus}
        </dd>
      </div>
      <div>
        <dt className="font-medium">To</dt>
        <dd>{record.to.join(", ")}</dd>
      </div>
      <div>
        <dt className="font-medium">Cc</dt>
        <dd>{record.cc.length ? record.cc.join(", ") : "None"}</dd>
      </div>
      <div>
        <dt className="font-medium">Bcc</dt>
        <dd>{record.bcc.length ? record.bcc.join(", ") : "None"}</dd>
      </div>
      <div>
        <dt className="font-medium">Subject</dt>
        <dd>{record.subject}</dd>
      </div>
      <div>
        <dt className="font-medium">Attachments and context</dt>
        <dd>No attachments. Only the text below is included; no files or conversation context are attached.</dd>
      </div>
      <div>
        <dt className="font-medium">Scope</dt>
        <dd>This workspace</dd>
      </div>
    </dl>
  );
}
