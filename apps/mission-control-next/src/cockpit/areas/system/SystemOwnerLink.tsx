import type { ReactNode } from "react";
import { resolveCockpitContinuation } from "../../app/cockpit-compatibility";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";

/** Existing source actions remain at their native owner; unavailable destinations stay explicit. */
export function SystemOwnerLink({
  href,
  scope,
  children,
  className,
}: {
  href: string;
  scope: unknown;
  children: ReactNode;
  className?: string;
}) {
  const owner = resolveCockpitContinuation(href, { search: window.location.search, hash: window.location.hash });
  if (owner.kind !== "native")
    return (
      // Static text, not an outcome: no live region and no link role.
      <span className="text-xs text-fg-muted">This page is not available here</span>
    );
  return (
    <NativeOwnerLink
      href={owner.href}
      scope={scope}
      className={className ?? "mt-2 inline-block text-sm font-medium text-accent hover:underline"}
    >
      {children}
    </NativeOwnerLink>
  );
}
