import { Children, type ReactNode } from "react";
import { resolveCockpitCompatibility } from "../../app/cockpit-compatibility";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";

/** Route coverage decides the owner; unsupported runtime controls keep their governed fallback. */
export function SystemOwnerLink({ href, scope, children }: { href: string; scope: unknown; children: ReactNode }) {
  const owner = resolveCockpitCompatibility(href);
  const className = "mt-2 inline-block text-sm font-medium text-accent hover:underline";
  if (owner.kind === "missing") return <span className="text-xs text-fg-muted">Source owner unavailable</span>;
  return owner.kind === "native"
    ? <NativeOwnerLink href={owner.href} scope={scope} className={className}>{children}</NativeOwnerLink>
    : <ClassicOwnerLink href={owner.href} scope={JSON.stringify(scope)} className={className} label={`${Children.toArray(children).join("")} in Classic`} />;
}
