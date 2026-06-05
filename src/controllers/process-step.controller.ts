import { authenticate } from '@loopback/authentication';
import {
  Count,
  CountSchema,
  Filter,
  FilterExcludingWhere,
  repository,
  Where,
} from '@loopback/repository';
import {
  del,
  get,
  getModelSchemaRef,
  param,
  patch,
  post,
  put,
  requestBody,
  response,
} from '@loopback/rest';
import { authorize } from '../authorization';
import { ProcessStep } from '../models/process-step.model';
import { ProcessStepRepository } from '../repositories/process-step.repository';
import { MediaService } from '../services/media.service';
import { inject } from '@loopback/core';

export class ProcessStepController {
  constructor(
    @repository(ProcessStepRepository)
    public processStepRepository: ProcessStepRepository,
    @inject('service.media.service')
    private mediaService: MediaService,
  ) { }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @post('/process-steps')
  @response(200, {
    description: 'ProcessStep model instance',
    content: { 'application/json': { schema: getModelSchemaRef(ProcessStep) } },
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(ProcessStep, {
            title: 'NewProcessStep',
            exclude: ['id', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    processStep: Omit<ProcessStep, 'id'>,
  ): Promise<ProcessStep> {
    const newProcessStep = await this.processStepRepository.create(processStep);
    if (newProcessStep.mediaId) {
      await this.mediaService.updateMediaUsedStatus([newProcessStep.mediaId], true);
    }
    return newProcessStep;
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/process-steps/count')
  @response(200, {
    description: 'ProcessStep model count',
    content: { 'application/json': { schema: CountSchema } },
  })
  async count(
    @param.where(ProcessStep) where?: Where<ProcessStep>,
  ): Promise<Count> {
    return this.processStepRepository.count(where);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/process-steps')
  @response(200, {
    description: 'Array of ProcessStep model instances',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: getModelSchemaRef(ProcessStep, { includeRelations: true }),
        },
      },
    },
  })
  async find(
    @param.filter(ProcessStep) filter?: Filter<ProcessStep>,
  ): Promise<ProcessStep[]> {
    return this.processStepRepository.find({
      ...filter,
      include: [
        { relation: 'media', scope: { fields: { id: true, fileOriginalName: true, fileUrl: true, fileType: true } } }
      ]
    });
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @patch('/process-steps')
  @response(200, {
    description: 'ProcessStep PATCH success count',
    content: { 'application/json': { schema: CountSchema } },
  })
  async updateAll(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(ProcessStep, { partial: true }),
        },
      },
    })
    processStep: Partial<ProcessStep>,
    @param.where(ProcessStep) where?: Where<ProcessStep>,
  ): Promise<Count> {
    return this.processStepRepository.updateAll(processStep, where);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/process-steps/{id}')
  @response(200, {
    description: 'ProcessStep model instance',
    content: {
      'application/json': {
        schema: getModelSchemaRef(ProcessStep, { includeRelations: true }),
      },
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(ProcessStep, { exclude: 'where' })
    filter?: FilterExcludingWhere<ProcessStep>,
  ): Promise<ProcessStep> {
    return this.processStepRepository.findById(id, {
      ...filter,
      include: [
        { relation: 'media', scope: { fields: { id: true, fileOriginalName: true, fileUrl: true, fileType: true } } }
      ]
    });
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @patch('/process-steps/{id}')
  @response(204, { description: 'ProcessStep PATCH success' })
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(ProcessStep, { partial: true }),
        },
      },
    })
    processStep: Partial<ProcessStep>,
  ): Promise<void> {
    const oldProcessStep = await this.processStepRepository.findById(id);
    await this.processStepRepository.updateById(id, processStep);
    if (processStep.mediaId && oldProcessStep.mediaId !== processStep.mediaId) {
      await this.mediaService.updateMediaUsedStatus([oldProcessStep.mediaId], false);
      await this.mediaService.updateMediaUsedStatus([processStep.mediaId], true);
    }
  }

  // @authenticate('jwt')
  // @authorize({roles: ['super_admin']})
  // @put('/process-steps/{id}')
  // @response(204, {description: 'ProcessStep PUT success'})
  // async replaceById(
  //   @param.path.string('id') id: string,
  //   @requestBody() processStep: ProcessStep,
  // ): Promise<void> {
  //   await this.processStepRepository.replaceById(id, processStep);
  // }

  // @authenticate('jwt')
  // @authorize({roles: ['super_admin']})
  // @del('/process-steps/{id}')
  // @response(204, {description: 'ProcessStep DELETE success'})
  // async deleteById(@param.path.string('id') id: string): Promise<void> {
  //   await this.processStepRepository.updateById(id, {
  //     isDeleted: true,
  //     isActive: false,
  //     deletedAt: new Date() as any, // Cast to any if deletedAt explicitly expects string type
  //   } as any); // Cast update payload to any if isDeleted/isActive are missing from ProcessStep model
  // }
}
