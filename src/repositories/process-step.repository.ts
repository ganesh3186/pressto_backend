import {inject} from '@loopback/core';
import {DefaultCrudRepository, juggler} from '@loopback/repository';
import {ProcessStep, ProcessStepRelations} from '../models/process-step.model';

export class ProcessStepRepository extends DefaultCrudRepository<
  ProcessStep,
  typeof ProcessStep.prototype.id,
  ProcessStepRelations
> {
  constructor(@inject('datasources.db') dataSource: juggler.DataSource) {
    super(ProcessStep, dataSource);
  }
}
