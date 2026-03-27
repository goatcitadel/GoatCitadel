import type { ReactNode } from "react";
import { EmbeddedPageChromeProvider } from "./EmbeddedPageChrome";
import { SectionTitle } from "./SectionTitle";

interface ShellPageFrameProps {
  eyebrow: string;
  title: string;
  subtitle: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

export function ShellPageFrame({ eyebrow, title, subtitle, actions, children }: ShellPageFrameProps) {
  return (
    <section className="space-page stack-lg">
      <SectionTitle eyebrow={eyebrow} title={title} subtitle={subtitle} actions={actions} />
      <EmbeddedPageChromeProvider>
        {children}
      </EmbeddedPageChromeProvider>
    </section>
  );
}
