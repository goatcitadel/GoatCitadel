// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { MAX_TEXT_UPLOAD_BYTES, readTextFileForUpload } from "./library-file-read";

it("returns the name and text of a small file", async () => {
  expect(await readTextFileForUpload(new File(["0123456789"], "note.txt"))).toEqual({
    ok: true,
    name: "note.txt",
    content: "0123456789",
  });
});
it("refuses a file larger than the upload limit", async () => {
  const big = new File([new Uint8Array(MAX_TEXT_UPLOAD_BYTES + 1)], "big.txt");
  expect(await readTextFileForUpload(big)).toEqual({
    ok: false,
    message: "That file is larger than 1 MB, the most this form can upload. Choose a smaller text file.",
  });
});
it("refuses a file that is not plain text", async () => {
  expect(await readTextFileForUpload(new File(["a\u0000b"], "x.bin"))).toEqual({
    ok: false,
    message: "That file isn't plain text. Choose a text file such as .txt or .md.",
  });
});
