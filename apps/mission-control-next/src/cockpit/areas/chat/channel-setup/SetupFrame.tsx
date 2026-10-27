import type { ReactNode } from "react";
import { AreaHeader } from "../../../ui/AreaHeader";
import { AREA_COLUMN } from "../../../ui/area-layout";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";

/** The page every add-channel view shares: a title, a way back, and the view's content in the area column. */
export function SetupFrame({
  title,
  description,
  back,
  workspaceId,
  children,
}: {
  title: string;
  description?: string;
  back: { href: string; label: string };
  workspaceId: string;
  children?: ReactNode;
}) {
  return (
    <section aria-label={title} className={`${AREA_COLUMN} grid min-w-0 gap-6 p-4 md:p-6`}>
      <AreaHeader
        title={title}
        description={description}
        actions={
          <NativeOwnerLink href={back.href} scope={workspaceId} className="text-sm">
            {back.label}
          </NativeOwnerLink>
        }
      />
      {children}
    </section>
  );
}
