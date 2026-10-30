import { Button } from "../../../ui/Button";
import { QrCode } from "./QrCode";
import { WHATSAPP_CODE_EXPIRED, WHATSAPP_SAY_HI_TEXT, WHATSAPP_WAITING_FOR_HI, waMeLink } from "./whatsapp-setup-model";
import type { WhatsAppSetupState } from "./use-whatsapp-setup";

/**
 * Step 5: say hi to the business number with a one-time code, by scanning a code or opening a link on a phone that has
 * WhatsApp, with the code ready to send. Nothing here is a live region: the page's status line says "Waiting for your
 * message…" and what comes after. When the code expires, or could not be saved, the old code is not shown and a new one
 * is a click away; why it could not be saved is the page's own error message.
 */
export function WhatsAppSayHiStep({
  displayNumber,
  setup,
}: {
  /** The business number as Meta shows it, which the link is made from. */
  displayNumber: string;
  setup: Pick<WhatsAppSetupState, "code" | "codeExpired" | "busy" | "error" | "newCode">;
}) {
  const { code, codeExpired, busy, error, newCode } = setup;
  if (codeExpired || (!code && error)) {
    return (
      <>
        {codeExpired ? <p>{WHATSAPP_CODE_EXPIRED}</p> : null}
        <Button disabled={busy} onClick={() => void newCode()}>
          New code
        </Button>
      </>
    );
  }
  if (!code) return null;
  const link = waMeLink(displayNumber, code);
  return (
    <>
      <div className="flex flex-wrap items-start gap-4">
        <QrCode value={link} label="QR code that opens WhatsApp with your message" />
        <div className="min-w-48 flex-1 space-y-2 text-sm text-fg-secondary">
          <p>{WHATSAPP_SAY_HI_TEXT}</p>
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-accent underline-offset-2 hover:underline"
          >
            Open WhatsApp
          </a>
          <p>
            Or send {displayNumber} this message: <span className="font-mono text-fg">{code}</span>
          </p>
        </div>
      </div>
      <p className="text-sm text-fg-secondary">{WHATSAPP_WAITING_FOR_HI}</p>
    </>
  );
}
