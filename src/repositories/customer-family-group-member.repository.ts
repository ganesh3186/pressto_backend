import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {CustomerFamilyGroupMember, CustomerFamilyGroupMemberRelations} from '../models/customer-family-group-member.model';

export class CustomerFamilyGroupMemberRepository extends TimeStampRepositoryMixin<
  CustomerFamilyGroupMember,
  typeof CustomerFamilyGroupMember.prototype.id,
  Constructor<
    DefaultCrudRepository<
      CustomerFamilyGroupMember,
      typeof CustomerFamilyGroupMember.prototype.id,
      CustomerFamilyGroupMemberRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
  ) {
    super(CustomerFamilyGroupMember, dataSource);
  }
}
