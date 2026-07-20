/**
 * Runs `fn` over `items` with at most `concurrency` calls in flight at once, preserving
 * input order in the returned array. Used for per-item API calls (e.g. one Etsy inventory
 * fetch per listing) that would otherwise run one at a time in a sequential loop — with N
 * listings that's N round trips of latency stacked up serially instead of overlapped.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
