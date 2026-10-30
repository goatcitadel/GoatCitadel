import { useState } from "react";
import { cn } from "../../../lib/cn";
import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { Field } from "../../../ui/Field";
import { cockpitInputClass } from "../../../ui/input-class";
import {
  WHATSAPP_ADDRESS_CHECKED_EARLIER,
  WHATSAPP_ADDRESS_NOT_CHECKED,
  WHATSAPP_ADDRESS_WAITING,
  WHATSAPP_NOT_SUBSCRIBED,
  WHATSAPP_POINT_META_TEXT,
  WHATSAPP_VERIFY_TOKEN_HIDDEN,
} from "./whatsapp-setup-model";

/**
 * Text to copy into Meta, in a read-only field with a Copy button. The button's label is its own live word only: it
 * turns to Copied, never announces it, and stays on Copy when the browser has no clipboard or refuses the write (the
 * text stays on screen to select by hand). A new value starts on Copy again.
 */
function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const done = copied === value;

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
    } catch {
      // Copying is best-effort: with no clipboard, or one that says no, the label stays on Copy.
    }
  }

  return (
    <Field label={label}>
      {(props) => (
        <div className="flex items-center gap-2">
          <input
            {...props}
            type="text"
            readOnly
            autoComplete="off"
            spellCheck={false}
            className={cn(cockpitInputClass, "font-mono")}
            value={value}
            onFocus={(event) => event.target.select()}
          />
          <Button
            size="sm"
            className="shrink-0"
            aria-label={`${done ? "Copied" : "Copy"} ${label}`}
            onClick={() => void copy()}
          >
            {done ? "Copied" : "Copy"}
          </Button>
        </div>
      )}
    </Field>
  );
}

/**
 * Step 4: what the operator gives Meta (the Callback URL and the Verify token), and where GoatCitadel is in hearing back
 * from Meta. Nothing here is a live region: the page's status line announces what happens, and this step keeps it on
 * screen with no time in it, since it stays. The verify token is shown only while
 * the page holds the one it made; after a reload a new one is a click away, until Meta has checked the address. Ten
 * minutes without Meta's check say so here, with the button that waits again. The app is subscribed with a button, but
 * only when Meta says it isn't.
 */
export function WhatsAppAddressStep({
  callbackUrl,
  verifyToken,
  addressCheckedAt,
  addressExpired,
  appSubscribed,
  busy,
  onNewVerifyToken,
  onCheckAgain,
  onSubscribe,
}: {
  callbackUrl: string;
  /** The verify token the page holds, or null when it doesn't. */
  verifyToken: string | null;
  addressCheckedAt?: string;
  addressExpired: boolean;
  appSubscribed: boolean;
  busy: boolean;
  onNewVerifyToken: () => void;
  onCheckAgain: () => void;
  onSubscribe: () => void;
}) {
  return (
    <>
      <p className="text-sm text-fg-secondary">{WHATSAPP_POINT_META_TEXT}</p>
      <CopyField label="Callback URL" value={callbackUrl} />
      {verifyToken ? (
        <CopyField label="Verify token" value={verifyToken} />
      ) : addressCheckedAt ? null : (
        <div className="space-y-2">
          <p className="text-sm text-fg-secondary">{WHATSAPP_VERIFY_TOKEN_HIDDEN}</p>
          <Button disabled={busy} onClick={onNewVerifyToken}>
            Make a new verify token
          </Button>
        </div>
      )}
      {addressExpired ? (
        <Callout tone="warning" announce={false}>
          <p>{WHATSAPP_ADDRESS_NOT_CHECKED}</p>
          <div className="mt-2">
            <Button size="sm" disabled={busy} onClick={onCheckAgain}>
              Check again
            </Button>
          </div>
        </Callout>
      ) : (
        <p className="text-sm text-fg-secondary">
          {addressCheckedAt ? WHATSAPP_ADDRESS_CHECKED_EARLIER : WHATSAPP_ADDRESS_WAITING}
        </p>
      )}
      {appSubscribed ? null : (
        <div className="space-y-2">
          <p className="text-sm text-fg-secondary">{WHATSAPP_NOT_SUBSCRIBED}</p>
          <Button disabled={busy} onClick={onSubscribe}>
            Let this app receive your number's messages
          </Button>
        </div>
      )}
    </>
  );
}
