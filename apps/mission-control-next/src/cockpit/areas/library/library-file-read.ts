/** The Gateway's JSON upload body limit (apps/gateway/src/routes/files.ts). */
export const MAX_TEXT_UPLOAD_BYTES = 1024 * 1024;

export type TextFileRead = { ok: true; name: string; content: string } | { ok: false; message: string };

export async function readTextFileForUpload(file: File): Promise<TextFileRead> {
  if (file.size > MAX_TEXT_UPLOAD_BYTES)
    return {
      ok: false,
      message: "That file is larger than 1 MB, the most this form can upload. Choose a smaller text file.",
    };
  const content = await file.text();
  if (content.includes("\u0000"))
    return { ok: false, message: "That file isn't plain text. Choose a text file such as .txt or .md." };
  return { ok: true, name: file.name, content };
}
