/** A literal substring in both LoopBack's RegExp normalizer and PostgreSQL LIKE. */
export function literalContains(value: string): string {
  return '%' + value.replace(/[.*+?^${}()|[\]\\%_]/g, '\\$&') + '%';
}
