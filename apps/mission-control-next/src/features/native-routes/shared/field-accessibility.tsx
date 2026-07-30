import { Children, cloneElement, isValidElement, type ReactNode } from "react";

const DIRECT_FORM_CONTROL_TAGS = new Set(["input", "select", "textarea"]);

type AccessibleControlProps = {
  "aria-label"?: string;
  "aria-labelledby"?: string;
};

/**
 * Keep a field's visible label as the concise accessible name for its direct
 * native control. Implicit wrapping labels otherwise absorb help text and a
 * prefilled control value, making the control's name change with its content.
 */
export function labelDirectFormControls(children: ReactNode, labelId: string): ReactNode {
  return Children.map(children, (child) => {
    if (!isValidElement<AccessibleControlProps>(child) || typeof child.type !== "string") return child;
    if (!DIRECT_FORM_CONTROL_TAGS.has(child.type)) return child;
    if (child.props["aria-label"] || child.props["aria-labelledby"]) return child;
    return cloneElement(child, { "aria-labelledby": labelId });
  });
}
