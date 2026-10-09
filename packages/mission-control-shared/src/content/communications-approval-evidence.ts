import type { ApprovalRequest } from "@goatcitadel/contracts";
import type { ApprovalEvidenceModel } from "./approval-helpers.js";

const MAIL_SEND_CONSEQUENCE =
  "Approving records operator intent only. GoatCitadel does not send this message, and delivery is never confirmed.";

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const sameList = (left: string[], right: string[]) =>
  left.length === right.length && left.every((item, index) => item === right[index]);

/** Review a mail send approval only when its stored payload, preview and linkage describe the same draft. */
export function communicationsMailSendApprovalEvidence(approval: ApprovalRequest): ApprovalEvidenceModel | null {
  const payload = approval.payload as Record<string, unknown> | undefined;
  const preview = approval.preview as Record<string, unknown> | undefined;
  if (!payload || !preview || payload.action !== "mail_send") return null;
  const { draftId, accountId, to, cc, bcc, subject, bodyText } = payload;
  if (
    typeof draftId !== "string" ||
    typeof accountId !== "string" ||
    typeof subject !== "string" ||
    typeof bodyText !== "string" ||
    !isStringList(to) ||
    !isStringList(cc) ||
    !isStringList(bcc) ||
    !to.length
  )
    return null;
  if (
    preview.draftId !== draftId ||
    preview.accountId !== accountId ||
    preview.subject !== subject ||
    !isStringList(preview.to) ||
    !isStringList(preview.cc) ||
    !isStringList(preview.bcc) ||
    !sameList(preview.to, to) ||
    !sameList(preview.cc, cc) ||
    !sameList(preview.bcc, bcc)
  )
    return null;
  const linkage = approval.linkage;
  if (linkage?.actionType !== "communications.mail.send" || linkage.connectorId !== accountId) return null;
  const targets = [
    `To: ${to.join(", ")}`,
    ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
    ...(bcc.length ? [`Bcc: ${bcc.join(", ")}`] : []),
  ];
  return {
    targets,
    commands: [],
    changes: [{ label: `Message: ${subject}`, content: bodyText }],
    supporting: ["Attachments: none"],
    scopeSummary: linkage.workspaceId
      ? `Workspace ${linkage.workspaceId}.`
      : "No workspace was recorded for this send request.",
    consequence: MAIL_SEND_CONSEQUENCE,
    technicalDetails: [{ label: "Draft record", content: `Draft ID: ${draftId}\nAccount ID: ${accountId}` }],
  };
}
