/**
 * Keeps a value for a short time, per process, and shares one load between
 * callers that ask for the same key at once. A failed load isn't kept.
 */
export class ShortLivedCache<T> {
  private readonly entries = new Map<
    string,
    {expiresAt: number; value: Promise<T>}
  >();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > this.now()) return existing.value;

    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      // A Map iterates in insertion order, so this is the oldest entry.
      this.entries.delete(this.entries.keys().next().value as string);
    }
    const value = load();
    const entry = {expiresAt: this.now() + this.ttlMs, value};
    this.entries.set(key, entry);
    value.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}
