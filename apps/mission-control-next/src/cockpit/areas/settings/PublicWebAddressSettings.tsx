import { PublicWebAddressField } from "./PublicWebAddressField";
import { usePublicWebAddressSettings } from "./public-web-address-state";

/**
 * Chat › Messaging › Advanced channel setup: where GoatCitadel tells the channel setup pages it can be reached from the
 * internet.
 */
export function PublicWebAddressSettings() {
  const settings = usePublicWebAddressSettings();
  return (
    <section id="public-web-address" aria-labelledby="public-web-address-title" className="space-y-2 pb-4">
      <h3 id="public-web-address-title" className="text-md font-semibold text-fg">
        Public web address
      </h3>
      <p className="text-sm text-fg-secondary">
        Channels that receive messages from the internet, such as WhatsApp, need to know where to send them. Set it once
        here and the setup pages build their addresses from it.
      </p>
      <PublicWebAddressField settings={settings} />
    </section>
  );
}
