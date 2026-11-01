import {expect} from '@loopback/testlab';
import {EmployeeController} from '../controllers/employee.controller';

describe('employee email search', () => {
  it('includes linked user email in both list and count filters', async () => {
    const listFilters: object[] = [];
    const countFilters: object[] = [];
    const controller = Object.assign(Object.create(EmployeeController.prototype), {
      dataSource: {
        execute: async (sql: string, params: unknown[]) => {
          // Matched within employees only, never across all Users.
          expect(sql).to.match(/FROM public\.employee e\s+JOIN public\.users u/);
          expect(params).to.eql(['%Abida@Example.com%', false, '%%']);
          return [{userId: 'user-1'}];
        },
      },
      employeeRepository: {
        find: async (filter: {where: object}) => {listFilters.push(filter.where); return [];},
        count: async (where: object) => {countFilters.push(where); return {count: 1};},
      },
      attachAdditionalScopeIds: async () => [],
    }) as EmployeeController;

    await controller.find(undefined, ' Abida@Example.com ', 10, 0);
    await controller.count(' Abida@Example.com ');

    const expected = {and: [
      {isDeleted: false},
      {or: [
        {firstName: {ilike: '%Abida@Example.com%'}},
        {lastName: {ilike: '%Abida@Example.com%'}},
        {employeeCode: {ilike: '%Abida@Example.com%'}},
        {userId: {inq: ['user-1']}},
      ]},
    ]};
    expect(listFilters).to.eql([expected]);
    expect(countFilters).to.eql([expected]);
  });
});
