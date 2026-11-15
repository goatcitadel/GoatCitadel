import { channelAdvancedSetupHref } from "../../../app/routes";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import { noKeyStoreLinkText } from "./no-key-store";

/**
 * A failure of a channel's setup page as it reads on screen. When the sentence names the channel's guide in Advanced
 * channel setup (this computer has no secure storage for keys), those words link there; any other text stays as it is.
 */
export function ChannelFailureText({
  error,
  channelName,
  catalogId,
  workspaceId,
}: {
  error: string;
  channelName: string;
  catalogId: string;
  workspaceId: string;
}) {
  const link = noKeyStoreLinkText(channelName);
  const at = error.indexOf(link);
  if (at < 0) return <>{error}</>;
  return (
    <>
      {error.slice(0, at)}
      <NativeOwnerLink href={channelAdvancedSetupHref(catalogId)} scope={workspaceId}>
        {link}
      </NativeOwnerLink>
      {error.slice(at + link.length)}
    </>
  );
}
