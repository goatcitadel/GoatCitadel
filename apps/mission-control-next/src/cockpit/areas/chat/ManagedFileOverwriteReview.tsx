import { useEffect, useRef } from "react";
import { Button } from "../../ui/Button";

export function ManagedFileOverwriteReview({
  path,
  disabled,
  onCancel,
  onConfirm,
}: {
  path: string;
  disabled: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);

  return (
    <div role="group" aria-label={`Confirm overwrite of ${path}`} className="grid gap-2">
      <p className="text-sm text-fg-secondary">
        A file already exists at this path in the original project folder. Replace it with the managed version?
      </p>
      <div className="flex flex-wrap gap-2">
        <Button ref={cancelRef} size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="danger" disabled={disabled} onClick={onConfirm}>
          Overwrite and publish
        </Button>
      </div>
    </div>
  );
}
