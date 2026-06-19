export async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  if (items.length === 0) {
    return [];
  }
  const workerCount = Math.max(1, Math.min(items.length, Math.floor(concurrency)));
  const results = new Array<U>(items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index] as T, index);
      }
    }),
  );

  return results;
}
