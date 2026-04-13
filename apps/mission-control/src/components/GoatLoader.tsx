import { SignalLoader } from "./SignalLoader";

interface GoatLoaderProps {
  label?: string;
  compact?: boolean;
}

export function GoatLoader({ label = "Working...", compact = false }: GoatLoaderProps) {
  return <SignalLoader label={label} compact={compact} />;
}
