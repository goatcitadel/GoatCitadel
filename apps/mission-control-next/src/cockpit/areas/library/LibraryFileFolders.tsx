import { forwardRef } from "react";
import { Button } from "../../ui/Button";

/** Splits a folder path relative to the shared file root into breadcrumb steps. */
export function folderTrail(dir: string): { label: string; dir: string }[] {
  const parts = dir === "." ? [] : dir.split("/").filter(Boolean);
  return [
    { label: "Shared files", dir: "." },
    ...parts.map((part, index) => ({ label: part, dir: parts.slice(0, index + 1).join("/") })),
  ];
}

/**
 * Breadcrumb and subfolder list for the shared file root. The current folder takes focus after a move,
 * so keyboard users land on where they now are rather than on <body>.
 */
export const LibraryFileFolders = forwardRef<
  HTMLSpanElement,
  { dir: string; folders: string[]; disabled: boolean; onOpen: (dir: string) => void }
>(function LibraryFileFolders({ dir, folders, disabled, onOpen }, currentRef) {
  const trail = folderTrail(dir);
  return (
    <div className="grid gap-2">
      <nav aria-label="Folder path">
        <ol className="flex flex-wrap items-center gap-1 text-sm">
          {trail.map((step, index) => (
            <li key={step.dir} className="flex items-center gap-1">
              {index ? <span aria-hidden="true">/</span> : null}
              {index === trail.length - 1 ? (
                <span ref={currentRef} tabIndex={-1} aria-current="page" className="font-semibold text-fg">
                  {step.label}
                </span>
              ) : (
                <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onOpen(step.dir)}>
                  {step.label}
                </Button>
              )}
            </li>
          ))}
        </ol>
      </nav>
      {folders.length ? (
        <ul aria-label="Folders here" className="flex flex-wrap gap-2">
          {folders.map((folder) => (
            <li key={folder}>
              <Button
                size="sm"
                disabled={disabled}
                aria-label={`Open folder ${folder}`}
                onClick={() => onOpen(dir === "." ? folder : `${dir}/${folder}`)}
              >
                {folder}/
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
});
