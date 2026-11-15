import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { Tooltip } from "./Tooltip";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  label: string;
  icon: ReactNode;
}

// Classes that place the control in its parent (position, margin, flex item, display); a wrapper must carry them.
const PLACEMENT =
  /^(?:[a-z0-9-]+:)*(?:-?m[xytblrse]?-|flex-|grow|shrink|self-|order-|col-|row-|justify-self|place-self|absolute$|relative$|fixed$|sticky$|-?inset|-?top-|-?left-|-?right-|-?bottom-|z-|hidden$|block$|inline(?:-flex|-block)?$|flex$)/;
function splitPlacement(className: string | undefined) {
  const tokens = (className ?? "").split(/\s+/).filter(Boolean);
  return {
    placement: tokens.filter((token) => PLACEMENT.test(token)).join(" "),
    look: tokens.filter((token) => !PLACEMENT.test(token)).join(" "),
  };
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, className, type = "button", ...props },
  ref,
) {
  const { placement, look } = props.disabled ? splitPlacement(className) : { placement: "", look: className };
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-md text-fg-secondary transition-colors enabled:hover:bg-sunken enabled:hover:text-fg disabled:cursor-not-allowed disabled:text-fg-muted disabled:opacity-60",
        props.disabled && "pointer-events-none",
        look,
      )}
      {...props}
      // The tooltip says what the accessible name already says; do not read it twice.
      aria-describedby={props["aria-describedby"]}
    >
      {icon}
    </button>
  );
  // A disabled button fires no pointer events, so its wrapper carries the tooltip and the not-allowed cursor.
  return (
    <Tooltip label={label}>
      {props.disabled ? (
        <span className={cn("inline-flex cursor-not-allowed rounded-md", placement)}>{button}</span>
      ) : (
        button
      )}
    </Tooltip>
  );
});
