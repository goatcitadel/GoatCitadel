import { timingSafeEqual } from "node:crypto";

export function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  const comparableLength = Math.max(leftBuffer.length, rightBuffer.length, 1);
  const leftComparable = Buffer.alloc(comparableLength);
  const rightComparable = Buffer.alloc(comparableLength);
  leftBuffer.copy(leftComparable);
  rightBuffer.copy(rightComparable);

  const contentsEqual = timingSafeEqual(leftComparable, rightComparable);
  return leftBuffer.length === rightBuffer.length && contentsEqual;
}
