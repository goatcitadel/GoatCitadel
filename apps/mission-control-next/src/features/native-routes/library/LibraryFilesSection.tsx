import { useEffect, useMemo, useState } from "react";
import { Download, FileText, Upload } from "lucide-react";
import {
  createFileFromTemplate,
  downloadFile,
  fetchFileTemplates,
  fetchFilesList,
  uploadFile,
} from "@goatcitadel/mission-control-shared/api/client";
import { NativeCard } from "../NativeRoutePageLayout";
import type { NativeRoutePagesProps } from "../types";
import {
  formatBytes,
  formatDateTime,
  getErrorMessage,
  nativeLoad,
  nativeLoadIssues,
  truncateText,
  useAsyncLoad,
  type LoadState,
  type Notice,
} from "../shared/native-helpers";
import {
  LibraryActionList,
  LibraryActionCardGrid,
  LibraryButtonRow,
  LibraryCodeBlock,
  LibraryEmptyState,
  LibraryField,
  LibraryFieldGrid,
  LibraryLoadWarnings,
  LibraryNotice,
  LibrarySectionShell,
  LibrarySelectableList,
} from "../shared/library-primitives";

export function LibraryFilesSection({
  activeCitadelId,
  activeCitadelName,
  activeWorkspaceId,
  activeWorkspaceName,
}: NativeRoutePagesProps) {
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [targetPath, setTargetPath] = useState("");
  const [uploadPath, setUploadPath] = useState("");
  const [uploadContent, setUploadContent] = useState("");
  const [uploading, setUploading] = useState(false);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [preview, setPreview] = useState<LoadState<{ content: string; contentType: string; encoding: string }>>({
    loading: false,
    error: null,
    data: null,
  });
  const { loading, error, data, reload } = useAsyncLoad(async () => {
    const [files, templates] = await Promise.all([
      nativeLoad("Files", fetchFilesList(".", 120, { citadelId: activeCitadelId, workspaceId: activeWorkspaceId }), {
        items: [],
      }),
      nativeLoad("File templates", fetchFileTemplates(), { items: [] }),
    ]);
    return {
      issues: nativeLoadIssues([files, templates]),
      files: files.data.items,
      templates: templates.data.items,
    };
  }, [activeCitadelId, activeWorkspaceId]);

  const visibleFiles = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (data?.files ?? []).filter((item) => !query || item.relativePath.toLowerCase().includes(query));
  }, [data?.files, search]);
  const selectedFile = visibleFiles.find((item) => item.relativePath === selectedFilePath) ?? null;

  useEffect(() => {
    if (!visibleFiles.length) {
      setSelectedFilePath("");
      return;
    }
    setSelectedFilePath((current) =>
      visibleFiles.some((item) => item.relativePath === current) ? current : (visibleFiles[0]?.relativePath ?? ""),
    );
  }, [visibleFiles]);

  useEffect(() => {
    if (!data?.templates.length) {
      setSelectedTemplateId("");
      return;
    }
    setSelectedTemplateId((current) =>
      data.templates.some((item) => item.templateId === current) ? current : (data.templates[0]?.templateId ?? ""),
    );
  }, [data?.templates]);

  useEffect(() => {
    if (!selectedFilePath) {
      setPreview({ loading: false, error: null, data: null });
      return;
    }
    let cancelled = false;
    setPreview({ loading: true, error: null, data: null });
    void downloadFile(selectedFilePath, { citadelId: activeCitadelId, workspaceId: activeWorkspaceId })
      .then((file) => {
        if (!cancelled) {
          setPreview({
            loading: false,
            error: null,
            data: {
              content: file.content,
              contentType: file.contentType,
              encoding: file.encoding,
            },
          });
        }
      })
      .catch((previewError: Error) => {
        if (!cancelled) {
          setPreview({ loading: false, error: previewError.message, data: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeCitadelId, activeWorkspaceId, selectedFilePath]);

  const handleCreateFromTemplate = async () => {
    if (!selectedTemplateId) {
      setNotice({ tone: "warning", message: "Choose a template before creating a file." });
      return;
    }
    try {
      const created = await createFileFromTemplate(selectedTemplateId, targetPath.trim() || undefined, {
        citadelId: activeCitadelId,
        workspaceId: activeWorkspaceId,
      });
      setNotice({ tone: "success", message: `${created.relativePath} created from template.` });
      setTargetPath("");
      await reload();
      setSelectedFilePath(created.relativePath);
    } catch (createError) {
      setNotice({ tone: "error", message: getErrorMessage(createError) });
    }
  };

  const handleUpload = async () => {
    if (!uploadPath.trim() || !uploadContent) {
      setNotice({ tone: "warning", message: "Upload path and text content are required." });
      return;
    }
    setUploading(true);
    try {
      const uploaded = await uploadFile(uploadPath.trim(), uploadContent);
      setNotice({ tone: "success", message: `${uploaded.relativePath} uploaded.` });
      setUploadPath("");
      setUploadContent("");
      await reload();
      setSelectedFilePath(uploaded.relativePath);
    } catch (uploadError) {
      setNotice({ tone: "error", message: getErrorMessage(uploadError) });
    } finally {
      setUploading(false);
    }
  };

  const handleDownload = () => {
    if (!selectedFilePath || !preview.data) return;
    downloadBrowserFile(selectedFilePath, preview.data);
    setNotice({ tone: "success", message: `${selectedFilePath} downloaded.` });
  };

  return (
    <LibrarySectionShell loading={loading} error={error} onRetry={reload}>
      {notice ? <LibraryNotice notice={notice} /> : null}
      <LibraryLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
      <div className="mc-next-settings-grid">
        <NativeCard
          title="Workspace files"
          subtitle="Browsable shared files outside the active Code surface."
          stats={[
            { label: "Visible", value: String(data?.files.length ?? 0) },
            { label: "Templates", value: String(data?.templates.length ?? 0) },
            { label: "Citadel", value: activeCitadelName ?? activeCitadelId ?? "legacy" },
          ]}
        >
          <div className="mc-next-settings-field-grid">
            <label className="mc-next-settings-field span-2">
              <span>Filter files</span>
              <input
                className="mc-next-settings-input"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search relative path"
              />
            </label>
          </div>
          <LibrarySelectableList
            items={visibleFiles.map((item) => ({
              id: item.relativePath,
              title: item.relativePath,
              meta: formatBytes(item.size),
              body: `${formatDateTime(item.modifiedAt)} · ${activeWorkspaceName}`,
            }))}
            selectedId={selectedFilePath}
            onSelect={setSelectedFilePath}
            emptyLabel="No files returned from the workspace."
          />
        </NativeCard>
        <div className="mc-next-settings-stack">
          <NativeCard
            title={selectedFilePath || "File preview"}
            subtitle={preview.data?.contentType ?? "Select a file to preview it."}
          >
            {preview.loading ? <LibraryEmptyState label="Loading file preview…" /> : null}
            {preview.error ? <LibraryEmptyState label={preview.error} /> : null}
            {selectedFilePath ? (
              <LibraryActionCardGrid
                items={[
                  {
                    id: "file-preview",
                    label: "Preview health",
                    value: preview.loading ? "Loading" : preview.error ? "Failed" : preview.data ? "Loaded" : "Queued",
                    description: preview.error ?? "The selected file is read through the gateway file API.",
                    meta: preview.data?.contentType ?? selectedFilePath,
                    tone: preview.error ? "warning" : preview.data ? "success" : "info",
                  },
                  {
                    id: "workspace-bind",
                    label: "Workspace binding",
                    value: activeWorkspaceName,
                    description: selectedFile
                      ? `${formatBytes(selectedFile.size)} · ${formatDateTime(selectedFile.modifiedAt)}`
                      : "Selected file metadata is not visible in the current filter.",
                    meta: selectedFilePath,
                    tone: selectedFile ? "info" : "warning",
                  },
                  {
                    id: "import-upload",
                    label: "Import / upload",
                    value: "Available",
                    description: "Upload a path-jailed UTF-8 text fixture or create a file from a governed template.",
                    actionLabel: "Use upload form",
                    tone: "success",
                  },
                  {
                    id: "project-link",
                    label: "Link to project",
                    value: "Manual today",
                    description:
                      "Project/file linking still needs an operator action surface before Library can attach this file directly.",
                    actionLabel: "Project flow pending",
                    tone: "neutral",
                  },
                ]}
              />
            ) : null}
            {!preview.loading && !preview.error && preview.data ? (
              <>
                <LibraryButtonRow>
                  <button type="button" className="mc-next-settings-filter" onClick={handleDownload}>
                    <Download size={16} />
                    Download file
                  </button>
                </LibraryButtonRow>
                <LibraryCodeBlock label="Preview">{truncateText(preview.data.content, 2600)}</LibraryCodeBlock>
              </>
            ) : null}
            {!preview.loading && !preview.error && !preview.data ? (
              <LibraryEmptyState label="Select a file to preview it." />
            ) : null}
          </NativeCard>
          <NativeCard
            title="Upload text file"
            subtitle="Writes through the Gateway path jail into the isolated workspace."
          >
            <LibraryFieldGrid>
              <LibraryField label="Upload path">
                <input
                  className="mc-next-settings-input"
                  value={uploadPath}
                  onChange={(event) => setUploadPath(event.target.value)}
                  placeholder="notes/usability-fixture.txt"
                />
              </LibraryField>
              <LibraryField label="Upload content" span={2}>
                <textarea
                  className="mc-next-settings-input"
                  value={uploadContent}
                  onChange={(event) => setUploadContent(event.target.value)}
                  placeholder="Deterministic fixture content"
                  rows={5}
                />
              </LibraryField>
            </LibraryFieldGrid>
            <LibraryButtonRow>
              <button
                type="button"
                className="mc-next-settings-filter"
                onClick={() => void handleUpload()}
                disabled={uploading || !uploadPath.trim() || !uploadContent}
              >
                <Upload size={16} />
                {uploading ? "Uploading..." : "Upload file"}
              </button>
            </LibraryButtonRow>
          </NativeCard>
          <NativeCard
            title="Create from template"
            subtitle="File creation stays accessible here instead of forcing you into Code first."
          >
            <LibraryFieldGrid>
              <LibraryField label="Template">
                <select
                  className="mc-next-settings-input"
                  value={selectedTemplateId}
                  onChange={(event) => setSelectedTemplateId(event.target.value)}
                >
                  {(data?.templates ?? []).map((item) => (
                    <option key={item.templateId} value={item.templateId}>
                      {item.title}
                    </option>
                  ))}
                </select>
              </LibraryField>
              <LibraryField label="Target path">
                <input
                  className="mc-next-settings-input"
                  value={targetPath}
                  onChange={(event) => setTargetPath(event.target.value)}
                  placeholder="Optional target path override"
                />
              </LibraryField>
            </LibraryFieldGrid>
            <LibraryActionList
              ariaLabel="File templates"
              items={(data?.templates ?? []).slice(0, 4).map((item) => ({
                id: item.templateId,
                label: item.title,
                description: item.description,
                meta: item.defaultPath,
              }))}
              emptyLabel="No file templates are available."
            />
            <LibraryButtonRow>
              <button type="button" className="mc-next-settings-filter" onClick={() => void handleCreateFromTemplate()}>
                <FileText size={16} />
                Create file
              </button>
            </LibraryButtonRow>
          </NativeCard>
        </div>
      </div>
    </LibrarySectionShell>
  );
}

function downloadBrowserFile(relativePath: string, file: { content: string; contentType: string; encoding: string }) {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new Error("Browser downloads are unavailable in this environment.");
  }
  const content =
    file.encoding === "base64"
      ? Uint8Array.from(atob(file.content), (character) => character.charCodeAt(0))
      : file.content;
  const objectUrl = URL.createObjectURL(new Blob([content], { type: file.contentType || "application/octet-stream" }));
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = relativePath.split(/[\\/]/u).at(-1) || "download";
  anchor.click();
  URL.revokeObjectURL(objectUrl);
}
