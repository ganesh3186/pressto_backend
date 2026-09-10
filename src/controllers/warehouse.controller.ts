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
  HttpErrors,
  param,
  patch,
  post,
  requestBody,
  response,
} from '@loopback/rest';
import { authorize } from '../authorization';
import { Warehouse } from '../models/warehouse.model';
import { RegionRepository } from '../repositories/region.repository';
import { WarehouseRepository } from '../repositories/warehouse.repository';

export class WarehouseController {
  constructor(
    @repository(WarehouseRepository)
    public warehouseRepository: WarehouseRepository,
    @repository(RegionRepository)
    public regionRepository: RegionRepository,
  ) { }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['warehouse:create']})
  @post('/warehouses')
  @response(200, {
    description: 'Warehouse model instance',
    content: { 'application/json': { schema: getModelSchemaRef(Warehouse) } },
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(Warehouse, {
            title: 'NewWarehouse',
            exclude: ['id', 'code', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    warehouse: Omit<Warehouse, 'id'>,
  ): Promise<Warehouse> {
    const region = await this.regionRepository.findOne({where: {id: warehouse.regionId, isDeleted: false}});
    if (!region) throw new HttpErrors.NotFound(`Region with id "${warehouse.regionId}" not found.`);
    const existing = await this.warehouseRepository.find({fields: {code: true}});
    let maxNum = 0;
    for (const w of existing) {
      const match = w.code?.match(/^WH(\d+)$/i);
      if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
    }
    warehouse.name = (warehouse.name as string).trim();
    const duplicate = await this.warehouseRepository.findOne({where: {name: {ilike: warehouse.name}, isDeleted: false}});
    if (duplicate) throw new HttpErrors.Conflict(`A warehouse with name "${warehouse.name}" already exists.`);
    warehouse.code = `WH${String(maxNum + 1).padStart(5, '0')}`;
    return this.warehouseRepository.create(warehouse);
  }

  @authenticate('jwt')
  @get('/warehouses/count')
  @response(200, {
    description: 'Warehouse model count',
    content: { 'application/json': { schema: CountSchema } },
  })
  async count(@param.where(Warehouse) where?: Where<Warehouse>): Promise<Count> {
    return this.warehouseRepository.count(where);
  }

  @authenticate('jwt')
  @get('/warehouses')
  @response(200, {
    description: 'Array of Warehouse model instances',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: getModelSchemaRef(Warehouse, { includeRelations: true }),
        },
      },
    },
  })
  async find(
    @param.filter(Warehouse) filter?: Filter<Warehouse>,
  ): Promise<Warehouse[]> {
    return this.warehouseRepository.find({
      ...filter,
      where: {and: [{isDeleted: false}, filter?.where ?? {}]},
      order: ['createdAt DESC'],
      include: [{ relation: 'region' }],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['warehouse:update']})
  @patch('/warehouses')
  @response(200, {
    description: 'Warehouse PATCH success count',
    content: { 'application/json': { schema: CountSchema } },
  })
  async updateAll(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(Warehouse, { partial: true }),
        },
      },
    })
    warehouse: Warehouse,
    @param.where(Warehouse) where?: Where<Warehouse>,
  ): Promise<Count> {
    return this.warehouseRepository.updateAll(warehouse, where);
  }

  @authenticate('jwt')
  @get('/warehouses/{id}')
  @response(200, {
    description: 'Warehouse model instance',
    content: {
      'application/json': {
        schema: getModelSchemaRef(Warehouse, { includeRelations: true }),
      },
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(Warehouse, { exclude: 'where' })
    filter?: FilterExcludingWhere<Warehouse>,
  ): Promise<Warehouse> {
    return this.warehouseRepository.findById(id, {
      ...filter,
      include: [{ relation: 'region' }],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['warehouse:update']})
  @patch('/warehouses/{id}')
  @response(204, { description: 'Warehouse PATCH success' })
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(Warehouse, { partial: true }),
        },
      },
    })
    warehouse: Partial<Warehouse>,
  ): Promise<void> {
    if (warehouse.regionId) {
      const region = await this.regionRepository.findOne({where: {id: warehouse.regionId, isDeleted: false}});
      if (!region) throw new HttpErrors.NotFound(`Region with id "${warehouse.regionId}" not found.`);
    }
    if (warehouse.name) {
      warehouse.name = (warehouse.name as string).trim();
      const duplicate = await this.warehouseRepository.findOne({where: {name: {ilike: warehouse.name}, isDeleted: false, id: {neq: id}} as any});
      if (duplicate) throw new HttpErrors.Conflict(`A warehouse with name "${warehouse.name}" already exists.`);
    }
    await this.warehouseRepository.updateById(id, warehouse);
  }
}
