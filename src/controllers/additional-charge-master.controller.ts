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
  del,
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
import {AdditionalChargeMaster} from '../models/additional-charge-master.model';
import {AdditionalChargeMasterRepository} from '../repositories/additional-charge-master.repository';

export class AdditionalChargeMasterController {
  constructor(
    @repository(AdditionalChargeMasterRepository)
    public additionalChargeMasterRepository: AdditionalChargeMasterRepository,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['additional_charge_master:create']})
  @post('/additional-charge-masters')
  @response(200, {
    description: 'AdditionalChargeMaster model instance',
    content: {'application/json': {schema: getModelSchemaRef(AdditionalChargeMaster)}},
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(AdditionalChargeMaster, {
            title: 'NewAdditionalChargeMaster',
            exclude: ['id', 'code', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    additionalChargeMaster: Omit<AdditionalChargeMaster, 'id'>,
  ): Promise<AdditionalChargeMaster> {
    additionalChargeMaster.name = (additionalChargeMaster.name as string).trim();
    const existing = await this.additionalChargeMasterRepository.findOne({where: {name: {ilike: additionalChargeMaster.name}, isDeleted: false}});
    if (existing) throw new HttpErrors.Conflict(`An additional charge with name "${additionalChargeMaster.name}" already exists.`);
    const all = await this.additionalChargeMasterRepository.find({fields: {code: true}});
    let maxNum = 0;
    for (const a of all) {
      const match = a.code?.match(/^ACM(\d+)$/i);
      if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
    }
    additionalChargeMaster.code = `ACM${String(maxNum + 1).padStart(3, '0')}`;
    return this.additionalChargeMasterRepository.create(additionalChargeMaster);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['additional_charge_master:read']})
  @get('/additional-charge-masters/count')
  @response(200, {
    description: 'AdditionalChargeMaster model count',
    content: {'application/json': {schema: CountSchema}},
  })
  async count(
    @param.where(AdditionalChargeMaster) where?: Where<AdditionalChargeMaster>,
  ): Promise<Count> {
    return this.additionalChargeMasterRepository.count(where);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['additional_charge_master:read']})
  @get('/additional-charge-masters')
  @response(200, {
    description: 'Array of AdditionalChargeMaster model instances',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: getModelSchemaRef(AdditionalChargeMaster, {includeRelations: true}),
        },
      },
    },
  })
  async find(
    @param.filter(AdditionalChargeMaster) filter?: Filter<AdditionalChargeMaster>,
  ): Promise<AdditionalChargeMaster[]> {
    return this.additionalChargeMasterRepository.find({...filter, where: {and: [{isDeleted: false}, filter?.where ?? {}]}, order: ['createdAt DESC']});
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['additional_charge_master:update']})
  @patch('/additional-charge-masters')
  @response(200, {
    description: 'AdditionalChargeMaster PATCH success count',
    content: {'application/json': {schema: CountSchema}},
  })
  async updateAll(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(AdditionalChargeMaster, {partial: true}),
        },
      },
    })
    additionalChargeMaster: AdditionalChargeMaster,
    @param.where(AdditionalChargeMaster) where?: Where<AdditionalChargeMaster>,
  ): Promise<Count> {
    return this.additionalChargeMasterRepository.updateAll(additionalChargeMaster, where);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['additional_charge_master:read']})
  @get('/additional-charge-masters/{id}')
  @response(200, {
    description: 'AdditionalChargeMaster model instance',
    content: {
      'application/json': {
        schema: getModelSchemaRef(AdditionalChargeMaster, {includeRelations: true}),
      },
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(AdditionalChargeMaster, {exclude: 'where'})
    filter?: FilterExcludingWhere<AdditionalChargeMaster>,
  ): Promise<AdditionalChargeMaster> {
    return this.additionalChargeMasterRepository.findById(id, filter);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['additional_charge_master:update']})
  @patch('/additional-charge-masters/{id}')
  @response(204, {description: 'AdditionalChargeMaster PATCH success'})
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(AdditionalChargeMaster, {partial: true}),
        },
      },
    })
    additionalChargeMaster: Partial<AdditionalChargeMaster>,
  ): Promise<void> {
    if (additionalChargeMaster.name) {
      additionalChargeMaster.name = (additionalChargeMaster.name as string).trim();
      const duplicate = await this.additionalChargeMasterRepository.findOne({where: {name: {ilike: additionalChargeMaster.name}, isDeleted: false, id: {neq: id}} as any});
      if (duplicate) throw new HttpErrors.Conflict(`An additional charge with name "${additionalChargeMaster.name}" already exists.`);
    }
    await this.additionalChargeMasterRepository.updateById(id, additionalChargeMaster);
  }

  // @authenticate('jwt')
  // @authorize({roles: ['super_admin']})
  // @del('/additional-charge-masters/{id}')
  // @response(204, {description: 'AdditionalChargeMaster DELETE success'})
  // async deleteById(@param.path.string('id') id: string): Promise<void> {
  //   await this.additionalChargeMasterRepository.updateById(id, {
  //     isDeleted: true,
  //     isActive: false,
  //     deletedAt: new Date() as any,
  //   } as any);
  // }
}
