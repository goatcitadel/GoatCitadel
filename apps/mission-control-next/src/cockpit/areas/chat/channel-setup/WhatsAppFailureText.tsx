import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import { settingsChannelSetupHref } from "./channel-picker-model";
import { WHATSAPP_CATALOG_ID, WHATSAPP_NO_KEY_STORE, WHATSAPP_NO_KEY_STORE_LINK } from "./whatsapp-setup-model";

/**
 * A failure of WhatsApp's page as it reads on screen: its one sentence. The sentence for a GoatCitadel with no secure
 * storage for keys names WhatsApp's guide in Settings, and those words link there, as the page's own Settings link does.
 */
export function WhatsAppFailureText({ error, workspaceId }: { error: string; workspaceId: string }) {
  if (error !== WHATSAPP_NO_KEY_STORE) return <>{error}</>;
  const at = WHATSAPP_NO_KEY_STORE.indexOf(WHATSAPP_NO_KEY_STORE_LINK);
  return (
    <>
      {WHATSAPP_NO_KEY_STORE.slice(0, at)}
      <NativeOwnerLink href={settingsChannelSetupHref(WHATSAPP_CATALOG_ID)} scope={workspaceId}>
        {WHATSAPP_NO_KEY_STORE_LINK}
      </NativeOwnerLink>
      {WHATSAPP_NO_KEY_STORE.slice(at + WHATSAPP_NO_KEY_STORE_LINK.length)}
    </>
  );
}
