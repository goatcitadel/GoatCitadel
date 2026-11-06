import { lazy, Suspense, useState, type ComponentProps } from "react";
import { PageErrorBoundary } from "@goatcitadel/mission-control-shared/components/PageErrorBoundary";
const WorkspaceChannelPlanReview = lazy(async () => ({
  default: (await import("./WorkspaceChannelPlanReview")).WorkspaceChannelPlanReview,
}));
export function DeferredWorkspaceChannelPlanReview(props: ComponentProps<typeof WorkspaceChannelPlanReview>) {
  const demanded = new URLSearchParams(props.routeSearch).has("channelPlan");
  const [warm, setWarm] = useState(demanded);
  if (demanded && !warm) setWarm(true);
  if (!warm && !demanded) return null;
  return (
    <div hidden={!demanded}>
      <PageErrorBoundary
        pageLabel="Channel setup review"
        resetKey={JSON.stringify([props.workspaceId, props.routeSearch])}
      >
        <Suspense fallback={demanded ? <p aria-busy="true">Opening channel setup review…</p> : null}>
          <WorkspaceChannelPlanReview {...props} />
        </Suspense>
      </PageErrorBoundary>
    </div>
  );
}
