/**
 * Splits `ids` into chunks of at most `size` and runs `fetch` once per
 * chunk, concatenating the results.
 *
 * A single `inq` array with tens of thousands of entries can break
 * loopback-connector-postgresql well under Postgres's own 65535
 * bind-parameter limit — confirmed in production: a mode-of-payment
 * report spanning several months across every store built a 26,455-entry
 * orderId list, and the connector sent a Bind message whose parameter
 * count didn't match its parameter-format count, failing the query
 * outright instead of executing it. Chunking sidesteps that entirely.
 */
export async function findInBatches<Id, Row>(
  ids: Id[],
  fetch: (batch: Id[]) => Promise<Row[]>,
  size = 2000,
): Promise<Row[]> {
  if (!ids.length) return [];
  const batches: Id[][] = [];
  for (let i = 0; i < ids.length; i += size) batches.push(ids.slice(i, i + size));
  return (await Promise.all(batches.map(fetch))).flat();
}
