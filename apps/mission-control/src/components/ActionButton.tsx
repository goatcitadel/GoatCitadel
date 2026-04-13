import { SignalLoader } from "./SignalLoader";

interface ActionButtonProps {
  label: string;
  pendingLabel?: string;
  onClick: () => void | Promise<void>;
  pending?: boolean;
  disabled?: boolean;
  danger?: boolean;
  variant?: "primary" | "secondary" | "tertiary" | "danger";
  type?: "button" | "submit";
  className?: string;
}

export function ActionButton({
  label,
  pendingLabel,
  onClick,
  pending = false,
  disabled = false,
  danger = false,
  variant = "secondary",
  type = "button",
  className,
}: ActionButtonProps) {
  const resolvedVariant = danger ? "danger" : variant;
  return (
    <button
      type={type}
      className={[
        "gc-button",
        `gc-action-button gc-action-${resolvedVariant}${resolvedVariant === "danger" ? " danger" : ""}${className ? ` ${className}` : ""}`,
      ]
        .filter(Boolean)
        .join(" ")}
      disabled={disabled || pending}
      onClick={() => void onClick()}
    >
      {pending ? <SignalLoader compact label={pendingLabel ?? "Applying..."} /> : label}
    </button>
  );
}
