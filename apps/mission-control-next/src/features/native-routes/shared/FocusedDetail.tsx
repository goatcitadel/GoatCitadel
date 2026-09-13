import { useEffect, useRef, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { NativeButton } from "../primitives";

/** Sustained reading and editing use the available working area. */
export function FocusedDetail({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const opener = typeof HTMLElement !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    heading.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  return <section className="mc-next-focused-detail" aria-label={title}>
    <header className="mc-next-focused-detail-header"><NativeButton variant="ghost" onClick={onClose}><ArrowLeft size={16} />Back to list</NativeButton><h2 ref={heading} tabIndex={-1}>{title}</h2></header>
    {children}
  </section>;
}
