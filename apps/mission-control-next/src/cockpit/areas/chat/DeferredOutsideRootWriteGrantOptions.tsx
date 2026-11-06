import { useEffect, useMemo, useState, useSyncExternalStore, type ComponentProps } from "react";
import { readOutsideRootWriteApprovalDetails } from "@goatcitadel/contracts";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import {
  getGatewayAccessRevision,
  getGatewayCallerScopeRevision,
  subscribeGatewayAccessChange,
  subscribeGatewayCallerScope,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { Button } from "../../ui/Button";

type GrantCode = typeof import("./OutsideRootWriteGrantOptions");
type Props = ComponentProps<GrantCode["OutsideRootWriteGrantOptions"]>;
let grantLoad: Promise<GrantCode> | undefined;
function loadGrantCode() {
  grantLoad ??= import("./OutsideRootWriteGrantOptions").catch((cause: unknown) => {
    grantLoad = undefined;
    throw cause;
  });
  return grantLoad;
}

/** Code only is shared. The grant owner still validates and re-reads every decision. */
export function DeferredOutsideRootWriteGrantOptions(props: Props) {
  const caller = useSyncExternalStore(subscribeGatewayCallerScope, getGatewayCallerScopeRevision, getGatewayCallerScopeRevision);
  const access = useSyncExternalStore(subscribeGatewayAccessChange, getGatewayAccessRevision, getGatewayAccessRevision);
  const gateway = getGatewayApiBaseUrl();
  const { activeWorkspaceId } = useUiPreferences();
  const scope = JSON.stringify([gateway, caller, access, activeWorkspaceId, props.workspaceId, props.sessionId]);
  const owner = useMemo(() => ({ scope, approval: props.approval }), [scope, props.approval]);
  const details = readOutsideRootWriteApprovalDetails(props.approval.preview?.outsideRootWrite);
  const eligible = props.approval.status === "pending" && Boolean(details?.candidates.length);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ owner: typeof owner; code?: GrantCode; failed?: true }>();
  useEffect(() => {
    if (!eligible) return;
    let current = true;
    void loadGrantCode().then(
      (code) => {
        if (current && getGatewayApiBaseUrl() === gateway && getGatewayCallerScopeRevision() === caller && getGatewayAccessRevision() === access)
          setState({ owner, code });
      },
      () => {
        if (current && getGatewayApiBaseUrl() === gateway && getGatewayCallerScopeRevision() === caller && getGatewayAccessRevision() === access)
          setState({ owner, failed: true });
      },
    );
    return () => { current = false; };
  }, [owner, eligible, gateway, caller, access, attempt]);
  if (!eligible) return null;
  const owned = state?.owner === owner ? state : undefined;
  if (owned?.code) return <owned.code.OutsideRootWriteGrantOptions {...props} />;
  if (owned?.failed) return (
    <div role="status" className="space-y-2">
      <p>Folder options could not load. You can still approve this write once or deny it.</p>
      <Button size="sm" onClick={() => { setState(undefined); setAttempt((value) => value + 1); }}>Try folder options again</Button>
    </div>
  );
  return <p aria-busy="true">Loading folder options…</p>;
}
