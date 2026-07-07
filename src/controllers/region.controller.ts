import {authenticate} from '@loopback/authentication';
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
  HttpErrors,
  param,
  patch,
  post,
  requestBody,
  response,
} from '@loopback/rest';
import {authorize} from '../authorization';
import {Region} from '../models/region.model';
import {RegionRepository} from '../repositories/region.repository';

export class RegionController {
  constructor(
    @repository(RegionRepository)
    public regionRepository: RegionRepository,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['region:create']})
  @post('/regions')
  @response(200, {
    description: 'Region model instance',
    content: {'application/json': {schema: getModelSchemaRef(Region)}},
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(Region, {
            title: 'NewRegion',
            exclude: ['id', 'code', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    region: Omit<Region, 'id'>,
  ): Promise<Region> {
    const existing = await this.regionRepository.find({fields: {code: true}});
    let maxNum = 0;
    for (const r of existing) {
      const match = r.code?.match(/^REG(\d+)$/i);
      if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
    }
    region.name = (region.name as string).trim();
    const duplicate = await this.regionRepository.findOne({where: {name: {ilike: region.name}, isDeleted: false}});
    if (duplicate) throw new HttpErrors.Conflict(`A region with name "${region.name}" already exists.`);
    region.code = `REG${String(maxNum + 1).padStart(3, '0')}`;
    return this.regionRepository.create(region);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['region:read']})
  @get('/regions/count')
  @response(200, {
    description: 'Region model count',
    content: {'application/json': {schema: CountSchema}},
  })
  async count(@param.where(Region) where?: Where<Region>): Promise<Count> {
    return this.regionRepository.count(where);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['region:read']})
  @get('/regions')
  @response(200, {
    description: 'Array of Region model instances',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: getModelSchemaRef(Region, {includeRelations: true}),
        },
      },
    },
  })
  async find(@param.filter(Region) filter?: Filter<Region>): Promise<Region[]> {
    return this.regionRepository.find({...filter, where: {and: [{isDeleted: false}, filter?.where ?? {}]}, order: ['createdAt DESC']});
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['region:update']})
  @patch('/regions')
  @response(200, {
    description: 'Region PATCH success count',
    content: {'application/json': {schema: CountSchema}},
  })
  async updateAll(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(Region, {partial: true}),
        },
      },
    })
    region: Region,
    @param.where(Region) where?: Where<Region>,
  ): Promise<Count> {
    return this.regionRepository.updateAll(region, where);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['region:read']})
  @get('/regions/{id}')
  @response(200, {
    description: 'Region model instance',
    content: {
      'application/json': {
        schema: getModelSchemaRef(Region, {includeRelations: true}),
      },
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(Region, {exclude: 'where'})
    filter?: FilterExcludingWhere<Region>,
  ): Promise<Region> {
    return this.regionRepository.findById(id, filter);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['region:update']})
  @patch('/regions/{id}')
  @response(204, {description: 'Region PATCH success'})
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(Region, {partial: true}),
        },
      },
    })
    region: Partial<Region>,
  ): Promise<void> {
    if (region.name) {
      region.name = (region.name as string).trim();
      const duplicate = await this.regionRepository.findOne({where: {name: {ilike: region.name}, isDeleted: false, id: {neq: id}} as any});
      if (duplicate) throw new HttpErrors.Conflict(`A region with name "${region.name}" already exists.`);
    }
    await this.regionRepository.updateById(id, region);
  }

  // @authenticate('jwt')
  // @authorize({roles: ['super_admin']})
  // @del('/regions/{id}')
  // @response(204, {description: 'Region DELETE success'})
  // async deleteById(@param.path.string('id') id: string): Promise<void> {
  //   await this.regionRepository.updateById(id, {
  //     isDeleted: true,
  //     isActive: false,
  //     deletedAt: new Date() as any,
  //   } as any);
  // }
}
