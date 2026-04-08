import { ActionButton } from "../../components/ActionButton";
import { Panel } from "../../components/Panel";

export interface ChatExternalBindingPanelProps {
  writable: boolean;
  integrationConnectionId: string;
  onIntegrationConnectionIdChange: (value: string) => void;
  integrationTarget: string;
  onIntegrationTargetChange: (value: string) => void;
  sending: boolean;
  pending: boolean;
  controlsDisabled: boolean;
  onSaveBinding: () => void;
}

export function ChatExternalBindingPanel(props: ChatExternalBindingPanelProps) {
  const {
    writable,
    integrationConnectionId,
    onIntegrationConnectionIdChange,
    integrationTarget,
    onIntegrationTargetChange,
    sending,
    pending,
    controlsDisabled,
    onSaveBinding,
  } = props;

  return (
    <>
      {!writable ? (
        <div className="status-banner warning">
          This external chat is read-only right now. Set a connection and target before sending replies out.
        </div>
      ) : null}
      <Panel
        className="chat-v11-external-bind"
        title="External connection binding"
        subtitle="Bind this session to a writable external channel before trying to send messages out."
      >
        <input
          value={integrationConnectionId}
          onChange={(event) => onIntegrationConnectionIdChange(event.target.value)}
          placeholder="Connection ID (example: slack:workspace-a)"
        />
        <input
          value={integrationTarget}
          onChange={(event) => onIntegrationTargetChange(event.target.value)}
          placeholder="Target (example: #ops-room or thread id)"
        />
        <ActionButton
          label="Save binding"
          disabled={sending || controlsDisabled}
          pending={pending}
          onClick={onSaveBinding}
        />
      </Panel>
    </>
  );
}
