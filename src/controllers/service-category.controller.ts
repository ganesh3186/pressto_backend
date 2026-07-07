import {
  Count,
  CountSchema,
  Filter,
  FilterExcludingWhere,
  repository,
  Where,
} from '@loopback/repository';
import {
  post,
  param,
  get,
  getModelSchemaRef,
  HttpErrors,
  patch,
  requestBody,
  response,
} from '@loopback/rest';
import { ServiceCategory } from '../models';
import { ServiceCategoryRepository } from '../repositories';
import { authenticate } from '@loopback/authentication';
import { authorize } from '../authorization';

export class ServiceCategoryController {
  constructor(
    @repository(ServiceCategoryRepository)
    public serviceCategoryRepository: ServiceCategoryRepository,
  ) { }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @post('/service-categories')
  @response(200, {
    description: 'ServiceCategory model instance',
    content: { 'application/json': { schema: getModelSchemaRef(ServiceCategory) } },
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(ServiceCategory, {
            title: 'NewServiceCategory',
            exclude: ['id', 'code'],
          }),
        },
      },
    })
    serviceCategory: Omit<ServiceCategory, 'id'>,
  ): Promise<ServiceCategory> {
    const existing = await this.serviceCategoryRepository.find({fields: {code: true}});
    let maxNum = 0;
    for (const cat of existing) {
      const match = cat.code?.match(/^SCAT(\d+)$/i);
      if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
    }
    serviceCategory.name = (serviceCategory.name as string).trim();
    const duplicate = await this.serviceCategoryRepository.findOne({where: {name: {ilike: serviceCategory.name}, isDeleted: false}});
    if (duplicate) throw new HttpErrors.Conflict(`A service category with name "${serviceCategory.name}" already exists.`);
    serviceCategory.code = `SCAT${String(maxNum + 1).padStart(3, '0')}`;
    return this.serviceCategoryRepository.create(serviceCategory);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/service-categories/count')
  @response(200, {
    description: 'ServiceCategory model count',
    content: { 'application/json': { schema: CountSchema } },
  })
  async count(
    @param.where(ServiceCategory) where?: Where<ServiceCategory>,
  ): Promise<Count> {
    return this.serviceCategoryRepository.count(where);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/service-categories')
  @response(200, {
    description: 'Array of ServiceCategory model instances',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: getModelSchemaRef(ServiceCategory, { includeRelations: true }),
        },
      },
    },
  })
  async find(
    @param.filter(ServiceCategory) filter?: Filter<ServiceCategory>,
  ): Promise<ServiceCategory[]> {
    return this.serviceCategoryRepository.find({...filter, where: {and: [{isDeleted: false}, filter?.where ?? {}]}, order: ['createdAt DESC']});
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @patch('/service-categories')
  @response(200, {
    description: 'ServiceCategory PATCH success count',
    content: { 'application/json': { schema: CountSchema } },
  })
  async updateAll(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(ServiceCategory, { partial: true }),
        },
      },
    })
    serviceCategory: ServiceCategory,
    @param.where(ServiceCategory) where?: Where<ServiceCategory>,
  ): Promise<Count> {
    return this.serviceCategoryRepository.updateAll(serviceCategory, where);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/service-categories/{id}')
  @response(200, {
    description: 'ServiceCategory model instance',
    content: {
      'application/json': {
        schema: getModelSchemaRef(ServiceCategory, { includeRelations: true }),
      },
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(ServiceCategory, { exclude: 'where' }) filter?: FilterExcludingWhere<ServiceCategory>
  ): Promise<ServiceCategory> {
    return this.serviceCategoryRepository.findById(id, filter);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @patch('/service-categories/{id}')
  @response(204, {
    description: 'ServiceCategory PATCH success',
  })
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(ServiceCategory, { partial: true }),
        },
      },
    })
    serviceCategory: ServiceCategory,
  ): Promise<void> {
    if (serviceCategory.name) {
      serviceCategory.name = (serviceCategory.name as string).trim();
      const duplicate = await this.serviceCategoryRepository.findOne({where: {name: {ilike: serviceCategory.name}, isDeleted: false, id: {neq: id}} as any});
      if (duplicate) throw new HttpErrors.Conflict(`A service category with name "${serviceCategory.name}" already exists.`);
    }
    await this.serviceCategoryRepository.updateById(id, serviceCategory);
  }

  // @authenticate('jwt')
  // @authorize({ roles: ['super_admin'] })
  // @put('/service-categories/{id}')
  // @response(204, {
  //   description: 'ServiceCategory PUT success',
  // })
  // async replaceById(
  //   @param.path.string('id') id: string,
  //   @requestBody() serviceCategory: ServiceCategory,
  // ): Promise<void> {
  //   await this.serviceCategoryRepository.replaceById(id, serviceCategory);
  // }

  // @authenticate('jwt')
  // @authorize({ roles: ['super_admin'] })
  // @del('/service-categories/{id}')
  // @response(204, {
  //   description: 'ServiceCategory DELETE success',
  // })
  // async deleteById(@param.path.string('id') id: string): Promise<void> {
  //   await this.serviceCategoryRepository.deleteById(id);
  // }
}
