import { useSyncExternalStore, type ComponentProps } from "react";
import { getGatewayCallerScope, subscribeGatewayCallerScope } from "@goatcitadel/mission-control-shared/api/access-scope";
import {
  createDeferredDialogRuntime,
  useDeferredDialogRuntime,
} from "@goatcitadel/mission-control-shared/components/ui/deferred-dialog";
import type { ChatLegacyInputReview } from "./ChatLegacyInputReview";

const reviewLoader = createDeferredDialogRuntime(() =>
  import("./ChatLegacyInputReview").then(({ ChatLegacyInputReview }) => ChatLegacyInputReview),
);

function hasSavedInput(key: string) {
  try {
    return typeof window !== "undefined" && Boolean(window.localStorage.getItem(key));
  } catch {
    return false;
  }
}

export function ChatLegacyInputNotice(props: Omit<ComponentProps<typeof ChatLegacyInputReview>, "storageKey">) {
  const caller = useSyncExternalStore(subscribeGatewayCallerScope, getGatewayCallerScope, getGatewayCallerScope);
  const key = `goatcitadel.chat.draft.${props.workspaceId}.${props.sessionId ?? "new"}`;
  const eligible = Boolean(!reviewLoader.read() && caller && props.workspaceId && hasSavedInput(key));
  const { runtime: Review, failed } = useDeferredDialogRuntime(eligible, reviewLoader);
  if (Review) return <Review {...props} storageKey={key} />;
  if (!eligible) return null;

  return (
    <p role={failed ? "alert" : "status"} className="mt-2 text-xs text-fg-secondary">
      {failed ? "Saved input review could not load. Reload the app to review it." : "Loading saved input review…"}
    </p>
  );
}
