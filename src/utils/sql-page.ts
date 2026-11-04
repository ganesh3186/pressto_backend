import {HttpErrors} from '@loopback/rest';
import {Filter, Where} from '@loopback/repository';

type SqlConnector = {
  buildWhere(model: string, where: object): {sql: string; params: unknown[]};
  parameterize(query: {sql: string; params: unknown[]}): {sql: string; params: unknown[]};
};
type SqlSource = {connector: SqlConnector; execute(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>};

export function pageBounds(limit = 100, skip = 0, page?: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500 ||
      !Number.isInteger(skip) || skip < 0 ||
      (page !== undefined && (!Number.isInteger(page) || page < 1))) {
    throw new HttpErrors.BadRequest('Use limit 1–500, non-negative skip and page starting at 1.');
  }
  return {limit, skip: page === undefined ? skip : (page - 1) * limit};
}

/** Internal SQL fragment only: aliases are fixed by callers, never request input. */
export function visibleOrderSql(order: string) {
  return `(${order}.storeid = ANY(?::uuid[]) OR EXISTS (
    SELECT 1 FROM public.order_item scope_item
    JOIN public.garment scope_g ON scope_g.orderitemid = scope_item.id
    JOIN public.transfer scope_t ON scope_t.id = scope_g.activetransferid
    WHERE scope_item.orderid = ${order}.id AND scope_g.isdeleted = false
      AND scope_t.tostoreid = ANY(?::uuid[])))`;
}

/** Scope/filter before count and paging. Only the bounded page is hydrated. */
export async function sqlPage<T extends {id: string}>(
  repo: {dataSource: unknown; entityClass: {modelName: string}; find(filter: Filter<T>): Promise<T[]>},
  table: string, where: object, limit: number, skip: number,
  extraSql = '', extraParams: unknown[] = [],
  order: string | string[] = ['createdAt DESC', 'id DESC'],
): Promise<{rows: T[]; total: number}> {
  if (!/^[a-z_]+$/.test(table)) throw new Error('Invalid internal table');
  const source = repo.dataSource as SqlSource;
  const filter = source.connector.buildWhere(repo.entityClass.modelName, where);
  const predicate = [filter.sql.replace(/^WHERE\s+/i, ''), extraSql].filter(Boolean).map(s => `(${s})`).join(' AND ') || 'TRUE';
  const from = `FROM public.${table} WHERE ${predicate}`;
  const params = [...filter.params, ...extraParams];
  const columns = (Array.isArray(order) ? order : [order]).flatMap(value => value.split(',')).map(value => {
    const match = value.trim().match(/^([a-zA-Z][a-zA-Z0-9_]*)(?:\s+(ASC|DESC))?$/i);
    if (!match) throw new HttpErrors.BadRequest('Invalid sorting expression.');
    return `"${match[1].toLowerCase()}" ${(match[2] ?? 'ASC').toUpperCase()}`;
  });
  if (!columns.some(column => column.startsWith('"id" '))) columns.push('"id" DESC');
  const query = source.connector.parameterize({sql: `SELECT
    (SELECT count(*) ${from}) AS total,
    ARRAY(SELECT id ${from} ORDER BY ${columns.join(', ')} LIMIT ? OFFSET ?) AS ids`,
    params: [...params, ...params, limit, skip]});
  const result = await source.execute(query.sql, query.params);
  const ids = (result[0]?.ids ?? []) as string[];
  const found: T[] = ids.length ? await repo.find({where: {id: {inq: ids}} as Where<T>}) : [];
  const byId = new Map(found.map(row => [row.id, row]));
  return {rows: ids.map(id => byId.get(id)).filter((row): row is T => Boolean(row)), total: Number(result[0]?.total ?? 0)};
}

export async function sqlCount(
  repo: {dataSource: unknown; entityClass: {modelName: string}}, table: string,
  where: object, extraSql = '', extraParams: unknown[] = [],
): Promise<{count: number}> {
  if (!/^[a-z_]+$/.test(table)) throw new Error('Invalid internal table');
  const source = repo.dataSource as SqlSource;
  const base = source.connector.buildWhere(repo.entityClass.modelName, where);
  const conditions = [base.sql.replace(/^WHERE\s+/i, ''), extraSql].filter(Boolean).map(s => `(${s})`).join(' AND ') || 'TRUE';
  const query = source.connector.parameterize({sql: `SELECT count(*) AS count FROM public.${table} WHERE ${conditions}`, params: [...base.params, ...extraParams]});
  const rows = await source.execute(query.sql, query.params);
  return {count: Number(rows[0]?.count ?? 0)};
}
