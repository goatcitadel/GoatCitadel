export interface CapturedShellOutput {
  head: string;
  tail: string;
  omittedBytes: number;
}

/** Retains the complete short stream or a byte-bounded prefix and rolling suffix. */
export class ShellOutputCapture {
  private buffer?: Buffer;
  private totalBytes = 0;
  private readonly headBytes: number;

  constructor(private readonly maxBytes: number) {
    this.headBytes = Math.floor(maxBytes / 2);
  }

  public append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    const required = Math.min(this.totalBytes + chunk.length, this.maxBytes);
    if (!this.buffer || required > this.buffer.length) {
      const buffer = Buffer.allocUnsafe(Math.min(this.maxBytes, Math.max(required, (this.buffer?.length ?? 0) * 2)));
      this.buffer?.copy(buffer, 0, 0, this.totalBytes);
      this.buffer = buffer;
    }
    const buffer = this.buffer;
    const initialBytes = Math.min(chunk.length, Math.max(0, this.maxBytes - this.totalBytes));
    if (initialBytes > 0) chunk.copy(buffer, this.totalBytes, 0, initialBytes);
    this.totalBytes += initialBytes;
    const remaining = chunk.length - initialBytes;
    if (remaining === 0) return;

    const tailBytes = this.maxBytes - this.headBytes;
    const bytesToWrite = Math.min(remaining, tailBytes);
    const start = (this.totalBytes - this.headBytes + remaining - bytesToWrite) % tailBytes;
    const first = Math.min(bytesToWrite, tailBytes - start);
    const chunkStart = chunk.length - bytesToWrite;
    chunk.copy(buffer, this.headBytes + start, chunkStart, chunkStart + first);
    chunk.copy(buffer, this.headBytes, chunkStart + first);
    this.totalBytes += remaining;
  }

  public get exceededLimit(): boolean {
    return this.totalBytes > this.maxBytes;
  }

  public finish(): CapturedShellOutput {
    const buffer = this.buffer;
    if (!buffer || this.totalBytes <= this.maxBytes) {
      return { head: buffer?.toString("utf8", 0, this.totalBytes) ?? "", tail: "", omittedBytes: 0 };
    }

    const tailBytes = this.maxBytes - this.headBytes;
    const cursor = this.headBytes + ((this.totalBytes - this.headBytes) % tailBytes);
    const head = buffer.subarray(0, this.headBytes);
    const tail = Buffer.concat([buffer.subarray(cursor), buffer.subarray(this.headBytes, cursor)]);
    // Drop the incomplete lines at both sides of the gap. They can contain
    // fragments that the credential scrubber needs the complete line to recognize.
    const headEnd = head.lastIndexOf(10) + 1;
    const tailBoundary = tail.indexOf(10);
    const tailStart = tailBoundary === -1 ? tail.length : tailBoundary + 1;
    return {
      head: head.toString("utf8", 0, headEnd),
      tail: tail.toString("utf8", tailStart),
      omittedBytes: this.totalBytes - headEnd - (tail.length - tailStart),
    };
  }
}
