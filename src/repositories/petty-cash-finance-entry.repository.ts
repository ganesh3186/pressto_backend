import {inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {PettyCashFinanceEntry, PettyCashFinanceEntryRelations} from '../models/petty-cash-finance-entry.model';

export class PettyCashFinanceEntryRepository extends DefaultCrudRepository<
  PettyCashFinanceEntry,
  typeof PettyCashFinanceEntry.prototype.id,
  PettyCashFinanceEntryRelations
> {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(PettyCashFinanceEntry, dataSource);
  }
}
