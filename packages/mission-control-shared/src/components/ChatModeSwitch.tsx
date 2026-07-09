import type { ChatMode } from "@goatcitadel/contracts";
import { GCSegmentedControl } from "./ui";

export function ChatModeSwitch({
  disabled,
  onChange,
}: {
  value: ChatMode;
  disabled?: boolean;
  onChange: (mode: ChatMode) => void;
}) {
  return (
    <GCSegmentedControl
      value="chat"
      ariaLabel="Chat mode"
      className="chat-mode-switch"
      onChange={onChange}
      options={[{ value: "chat", label: "Chat", disabled }]}
    />
  );
}
