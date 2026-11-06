/** Caches compute()'s result until key() changes, so expensive pages are recomputed only after the data changed. */
export function memoByKey<T>(key: () => string, compute: () => T): () => T {
  let cached: { key: string; value: T } | undefined;
  return () => {
    const k = key();
    if (cached?.key !== k) cached = { key: k, value: compute() };
    return cached.value;
  };
}
