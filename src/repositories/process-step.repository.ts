import { inject } from '@loopback/core';
import { DefaultCrudRepository } from '@loopback/repository';
import { ProcessStep, ProcessStepRelations } from '../models/process-step.model';
import { presstoDataSource } from '../datasources';

export class ProcessStepRepository extends DefaultCrudRepository<
  ProcessStep,
  typeof ProcessStep.prototype.id,
  ProcessStepRelations
> {
  constructor(@inject('datasources.pressto') dataSource: presstoDataSource) {
    super(ProcessStep, dataSource);
  }
}
