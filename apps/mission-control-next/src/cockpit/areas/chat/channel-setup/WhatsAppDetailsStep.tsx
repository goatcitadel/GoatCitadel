import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { Field } from "../../../ui/Field";
import { cockpitInputClass } from "../../../ui/input-class";
import { TokenField } from "./TokenField";

/** The three details that are numbers and are not secret: they are kept in the page and sent with the secrets. */
export interface WhatsAppIds {
  phoneNumberId: string;
  businessAccountId: string;
  appId: string;
}

export const NO_WHATSAPP_IDS: WhatsAppIds = { phoneNumberId: "", businessAccountId: "", appId: "" };

/** The IDs as Meta names them, in the order the operator finds them in Meta's dashboard. */
const ID_FIELDS: ReadonlyArray<{ key: keyof WhatsAppIds; label: string }> = [
  { key: "phoneNumberId", label: "Phone number ID" },
  { key: "businessAccountId", label: "WhatsApp Business Account ID" },
  { key: "appId", label: "App ID" },
];

/**
 * Where the five details are pasted. The two secrets are masked and held by the caller in the volatile credential
 * store; the three IDs are numbers shown as typed. One button checks all five, and a failure shows beside the fields in
 * the one sentence the hook gives, with what was typed kept to be fixed.
 */
export function WhatsAppDetailsStep({
  ids,
  appSecret,
  accessToken,
  onId,
  onAppSecret,
  onAccessToken,
  busy,
  checking,
  error,
  onCheck,
}: {
  ids: WhatsAppIds;
  appSecret: string;
  accessToken: string;
  onId: (key: keyof WhatsAppIds, value: string) => void;
  onAppSecret: (value: string) => void;
  onAccessToken: (value: string) => void;
  /** Something is in flight: the fields are read-only and only the check that is running keeps its button. */
  busy: boolean;
  /** The check itself is in flight. */
  checking: boolean;
  error?: string;
  onCheck: () => void;
}) {
  const all =
    ID_FIELDS.every(({ key }) => ids[key].trim() !== "") && appSecret.trim() !== "" && accessToken.trim() !== "";
  return (
    <>
      {error ? (
        <Callout tone="error" announce={false}>
          <p>{error}</p>
        </Callout>
      ) : null}
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (all && !busy) onCheck();
        }}
      >
        {ID_FIELDS.map(({ key, label }) => (
          <Field key={key} label={label}>
            {(props) => (
              <input
                {...props}
                type="text"
                inputMode="numeric"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                className={cockpitInputClass}
                value={ids[key]}
                readOnly={busy}
                onChange={(event) => onId(key, event.target.value)}
              />
            )}
          </Field>
        ))}
        <TokenField label="App secret" value={appSecret} onChange={onAppSecret} busy={busy} />
        <TokenField label="Access token" value={accessToken} onChange={onAccessToken} busy={busy} />
        <Button
          type="submit"
          variant="primary"
          loading={checking}
          loadingLabel="Checking…"
          disabled={!all || (busy && !checking)}
        >
          Check
        </Button>
      </form>
    </>
  );
}
