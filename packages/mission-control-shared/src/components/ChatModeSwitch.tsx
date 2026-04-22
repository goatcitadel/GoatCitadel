import type { ChatMode } from "@goatcitadel/contracts";
import { GCSegmentedControl } from "./ui";

export function ChatModeSwitch({
  value,
  disabled,
  onChange,
}: {
  value: ChatMode;
  disabled?: boolean;
  onChange: (mode: ChatMode) => void;
}) {
  return (
    <GCSegmentedControl
      value={value}
      ariaLabel="Chat mode"
      className="chat-mode-switch"
      onChange={onChange}
      options={[
        { value: "chat", label: "Chat", disabled },
        { value: "cowork", label: "Cowork", disabled },
        { value: "code", label: "Code", disabled },
      ]}
    />
  );
}
