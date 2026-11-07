/* eslint-disable @typescript-eslint/no-explicit-any */
/** Adapt in-memory transactional fixtures to the repository batch API. */
export function batchedStubs(service: any) {
  for (const repo of Object.values(service) as any[]) {
    if (!repo || typeof repo !== 'object') continue;
    if (repo.updateById && !repo.updateAll) repo.updateAll = async (patch: object, where: any, options: object) => {
      const ids = where.id?.inq ?? [where.id];
      for (const id of ids) await repo.updateById(id, patch, options);
      return {count: ids.length};
    };
    if (repo.create && !repo.createAll) repo.createAll = async (rows: object[], options: object) => {
      const result = [];
      for (const row of rows) result.push(await repo.create(row, options));
      return result;
    };
  }
  return service;
}
