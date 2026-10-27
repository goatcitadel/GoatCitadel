import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { QrCode } from "./QrCode";
import type { TelegramSetupState } from "./use-telegram-setup";

export const MANY_WAITING_NOTE =
  "Your bot has more waiting messages than GoatCitadel can look through, so it can't see your hi yet. Clear them to continue. GoatCitadel skips them when it turns on anyway.";
export const WAITING_FOR_HI = "Waiting for your hi…";
export const CODE_EXPIRED = "This code expired.";

/** The link that opens the bot in Telegram with the code already filled in, so tapping Start sends it. */
export function startLink(username: string, code: string): string {
  return `https://t.me/${encodeURIComponent(username)}?start=${encodeURIComponent(code)}`;
}

/**
 * Step 3: say hi to the bot with a one-time code, by scanning a code, opening a link, or sending the code by hand.
 * Nothing here is a live region: the page's status line says "Waiting for your hi…" and what comes after. When the
 * code expires, or could not be saved, the old code is not shown and a new one is a click away; why it could not be
 * saved is the page's own error message. A bot with a full page of waiting messages hides the hi behind them: the
 * step says so and offers to clear them. Nothing GoatCitadel would have used is lost, so the button is a plain one.
 */
export function SayHiStep({
  username,
  setup,
}: {
  username: string;
  setup: Pick<
    TelegramSetupState,
    "code" | "codeExpired" | "manyWaiting" | "busy" | "error" | "newCode" | "clearWaiting"
  >;
}) {
  const { code, codeExpired, manyWaiting, busy, error, newCode, clearWaiting } = setup;
  if (codeExpired || (!code && error)) {
    return (
      <>
        {codeExpired ? <p>{CODE_EXPIRED}</p> : null}
        <Button disabled={busy} onClick={() => void newCode()}>
          Get a new code
        </Button>
      </>
    );
  }
  if (!code) return null;
  const link = startLink(username, code);
  return (
    <>
      <div className="flex flex-wrap items-start gap-4">
        <QrCode value={link} label="QR code that opens your bot" />
        <div className="min-w-48 flex-1 space-y-2 text-sm text-fg-secondary">
          <p>Scan this with your phone, or open your bot, then tap Start.</p>
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-accent underline-offset-2 hover:underline"
          >
            Open @{username}
          </a>
          <p>
            Can't see Start? Send your bot this code: <span className="font-mono text-fg">{code}</span>
          </p>
        </div>
      </div>
      <p className="text-sm text-fg-secondary">{WAITING_FOR_HI}</p>
      {manyWaiting ? (
        <Callout tone="info" announce={false}>
          <p>{MANY_WAITING_NOTE}</p>
          <div className="mt-2">
            <Button size="sm" disabled={busy} onClick={() => void clearWaiting()}>
              Clear waiting messages
            </Button>
          </div>
        </Callout>
      ) : null}
    </>
  );
}
