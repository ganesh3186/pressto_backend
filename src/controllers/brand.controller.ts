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
  HttpErrors,
  param,
  patch,
  post,
  put,
  requestBody,
  response,
} from '@loopback/rest';
import { authorize } from '../authorization';
import { Brand } from '../models/brand.model';
import { BrandRepository } from '../repositories/brand.repository';

export class BrandController {
  constructor(
    @repository(BrandRepository)
    public brandRepository: BrandRepository,
  ) { }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['brand:create']})
  @post('/brands')
  @response(200, {
    description: 'Brand model instance',
    content: { 'application/json': { schema: getModelSchemaRef(Brand) } },
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(Brand, {
            title: 'NewBrand',
            exclude: ['id', 'code', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    brand: Omit<Brand, 'id'>,
  ): Promise<Brand> {
    const existing = await this.brandRepository.find({ fields: { code: true } });
    let maxNum = 0;
    for (const b of existing) {
      const match = b.code?.match(/^BRD(\d+)$/i);
      if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
    }
    brand.name = (brand.name as string).trim();
    const duplicate = await this.brandRepository.findOne({where: {name: {ilike: brand.name}, isDeleted: false}});
    if (duplicate) throw new HttpErrors.Conflict(`A brand with name "${brand.name}" already exists.`);
    brand.code = `BRD${String(maxNum + 1).padStart(3, '0')}`;
    return this.brandRepository.create(brand);
  }

  @authenticate('jwt')
  @get('/brands/count')
  @response(200, {
    description: 'Brand model count',
    content: { 'application/json': { schema: CountSchema } },
  })
  async count(@param.where(Brand) where?: Where<Brand>): Promise<Count> {
    return this.brandRepository.count(where);
  }

  @authenticate('jwt')
  @get('/brands')
  @response(200, {
    description: 'Array of Brand model instances',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: getModelSchemaRef(Brand, { includeRelations: true }),
        },
      },
    },
  })
  async find(@param.filter(Brand) filter?: Filter<Brand>): Promise<Brand[]> {
    return this.brandRepository.find({...filter, where: {and: [{isDeleted: false}, filter?.where ?? {}]}, order: ['createdAt DESC']});
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['brand:update']})
  @patch('/brands')
  @response(200, {
    description: 'Brand PATCH success count',
    content: { 'application/json': { schema: CountSchema } },
  })
  async updateAll(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(Brand, { partial: true }),
        },
      },
    })
    brand: Brand,
    @param.where(Brand) where?: Where<Brand>,
  ): Promise<Count> {
    return this.brandRepository.updateAll(brand, where);
  }

  @authenticate('jwt')
  @get('/brands/{id}')
  @response(200, {
    description: 'Brand model instance',
    content: {
      'application/json': {
        schema: getModelSchemaRef(Brand, { includeRelations: true }),
      },
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(Brand, { exclude: 'where' })
    filter?: FilterExcludingWhere<Brand>,
  ): Promise<Brand> {
    return this.brandRepository.findById(id, filter);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['brand:update']})
  @patch('/brands/{id}')
  @response(204, { description: 'Brand PATCH success' })
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': { schema: getModelSchemaRef(Brand, { partial: true }) },
      },
    })
    brand: Brand,
  ): Promise<void> {
    if (brand.name) {
      brand.name = (brand.name as string).trim();
      const duplicate = await this.brandRepository.findOne({where: {name: {ilike: brand.name}, isDeleted: false, id: {neq: id}} as any});
      if (duplicate) throw new HttpErrors.Conflict(`A brand with name "${brand.name}" already exists.`);
    }
    await this.brandRepository.updateById(id, brand);
  }

  // @authenticate('jwt')
  // @authorize({roles: ['super_admin']})
  // @put('/brands/{id}')
  // @response(204, {description: 'Brand PUT success'})
  // async replaceById(
  //   @param.path.string('id') id: string,
  //   @requestBody() brand: Brand,
  // ): Promise<void> {
  //   await this.brandRepository.replaceById(id, brand);
  // }

  // @authenticate('jwt')
  // @authorize({roles: ['super_admin']})
  // @del('/brands/{id}')
  // @response(204, {description: 'Brand DELETE success'})
  // async deleteById(@param.path.string('id') id: string): Promise<void> {
  //   await this.brandRepository.deleteById(id);
  // }
}
