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
  get,
  getModelSchemaRef,
  param,
  patch,
  post,
  requestBody,
  response,
} from '@loopback/rest';
import { authorize } from '../authorization';
import { Service } from '../models/service.model';
import { ServiceRepository } from '../repositories/service.repository';
import { MediaService } from '../services/media.service';
import { inject } from '@loopback/core';

export class ServiceController {
  constructor(
    @repository(ServiceRepository)
    public serviceRepository: ServiceRepository,
    @inject('service.media.service')
    private mediaService: MediaService,
  ) { }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @post('/services')
  @response(200, {
    description: 'Service model instance',
    content: { 'application/json': { schema: getModelSchemaRef(Service) } },
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(Service, {
            title: 'NewService',
            exclude: ['id', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    service: Omit<Service, 'id'>,
  ): Promise<Service> {
    const existing = await this.serviceRepository.find({fields: {code: true}});
    let maxNum = 0;
    for (const s of existing) {
      const match = s.code?.match(/^SRV(\d+)$/i);
      if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
    }
    service.code = `SRV${String(maxNum + 1).padStart(3, '0')}`;
    const newService = await this.serviceRepository.create(service);
    if (newService.mediaId) {
      await this.mediaService.updateMediaUsedStatus([newService.mediaId], true);
    }
    return newService;
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/services/count')
  @response(200, {
    description: 'Service model count',
    content: { 'application/json': { schema: CountSchema } },
  })
  async count(@param.where(Service) where?: Where<Service>): Promise<Count> {
    return this.serviceRepository.count(where);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/services')
  @response(200, {
    description: 'Array of Service model instances',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: getModelSchemaRef(Service, { includeRelations: true }),
        },
      },
    },
  })
  async find(
    @param.filter(Service) filter?: Filter<Service>,
  ): Promise<Service[]> {
    return this.serviceRepository.find({
      ...filter,
      include: [
        { relation: 'media', scope: { fields: { id: true, fileOriginalName: true, fileUrl: true, fileType: true } } },
        { relation: 'serviceCategory', scope: { fields: { id: true, name: true } } }
      ]
    });
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @patch('/services')
  @response(200, {
    description: 'Service PATCH success count',
    content: { 'application/json': { schema: CountSchema } },
  })
  async updateAll(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(Service, { partial: true }),
        },
      },
    })
    service: Service,
    @param.where(Service) where?: Where<Service>,
  ): Promise<Count> {
    return this.serviceRepository.updateAll(service, where);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/services/{id}')
  @response(200, {
    description: 'Service model instance',
    content: {
      'application/json': {
        schema: getModelSchemaRef(Service, { includeRelations: true }),
      },
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(Service, { exclude: 'where' })
    filter?: FilterExcludingWhere<Service>,
  ): Promise<Service> {
    return this.serviceRepository.findById(id, {
      ...filter,
      include: [
        { relation: 'media', scope: { fields: { id: true, fileOriginalName: true, fileUrl: true, fileType: true } } }
      ]
    });
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @patch('/services/{id}')
  @response(204, { description: 'Service PATCH success' })
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(Service, { partial: true }),
        },
      },
    })
    service: Partial<Service>,
  ): Promise<void> {
    const oldService = await this.serviceRepository.findById(id);
    await this.serviceRepository.updateById(id, service);
    if (service.mediaId && oldService.mediaId !== service.mediaId) {
      if (oldService.mediaId) {
        await this.mediaService.updateMediaUsedStatus([oldService.mediaId], false);
      }
      await this.mediaService.updateMediaUsedStatus([service.mediaId], true);
    }
  }

  // @authenticate('jwt')
  // @authorize({roles: ['super_admin']})
  // @put('/services/{id}')
  // @response(204, {description: 'Service PUT success'})
  // async replaceById(
  //   @param.path.string('id') id: string,
  //   @requestBody() service: Service,
  // ): Promise<void> {
  //   await this.serviceRepository.replaceById(id, service);
  // }

  // @authenticate('jwt')
  // @authorize({roles: ['super_admin']})
  // @del('/services/{id}')
  // @response(204, {description: 'Service DELETE success'})
  // async deleteById(@param.path.string('id') id: string): Promise<void> {
  //   await this.serviceRepository.deleteById(id);
  // }
}
