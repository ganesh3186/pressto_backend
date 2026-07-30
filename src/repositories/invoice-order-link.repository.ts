import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {
  InvoiceOrderLink,
  InvoiceOrderLinkRelations,
} from '../models/invoice-order-link.model';

export class InvoiceOrderLinkRepository extends TimeStampRepositoryMixin<
  InvoiceOrderLink,
  typeof InvoiceOrderLink.prototype.id,
  Constructor<
    DefaultCrudRepository<
      InvoiceOrderLink,
      typeof InvoiceOrderLink.prototype.id,
      InvoiceOrderLinkRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
  ) {
    super(InvoiceOrderLink, dataSource);
  }
}
