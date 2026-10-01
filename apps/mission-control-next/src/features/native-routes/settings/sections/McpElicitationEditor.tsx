import type { McpElicitationRequest } from "@goatcitadel/contracts";
import { NativeButton } from "../../primitives";
import type { Notice } from "../SettingsShared";
import { McpElicitationResponseForm } from "../McpElicitationResponseForm";

export function McpElicitationEditor({
  workspaceId,
  request,
  onResolved,
  setNotice,
}: {
  workspaceId: string;
  request: McpElicitationRequest;
  setNotice: (notice: Notice) => void;
  onResolved: () => Promise<void>;
}) {
  return (
    <McpElicitationResponseForm
      request={request}
      workspaceId={workspaceId}
      onRecorded={async () => {
        setNotice({
          tone: "success",
          message:
            "MCP response confirmed in the Gateway elicitation owner. Remote delivery and durable execution are not confirmed.",
        });
        await onResolved();
      }}
      fieldClass="mc-next-settings-input"
      className="mc-next-settings-stack"
      button={(label, click, disabled) => (
        <NativeButton onClick={click} disabled={disabled}>
          {label}
        </NativeButton>
      )}
    />
  );
}
