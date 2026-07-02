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
  param,
  patch,
  post,
  requestBody,
  response,
} from '@loopback/rest';
import {authorize} from '../authorization';
import {Store} from '../models/store.model';
import {StoreRepository} from '../repositories/store.repository';

export class StoreController {
  constructor(
    @repository(StoreRepository)
    public storeRepository: StoreRepository,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @post('/stores')
  @response(200, {
    description: 'Store model instance',
    content: {'application/json': {schema: getModelSchemaRef(Store)}},
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(Store, {
            title: 'NewStore',
            exclude: ['id', 'code', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    store: Omit<Store, 'id'>,
  ): Promise<Store> {
    const existing = await this.storeRepository.find({fields: {code: true}});
    let maxNum = 0;
    for (const s of existing) {
      const match = s.code?.match(/^STR(\d+)$/i);
      if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
    }
    store.code = `STR${String(maxNum + 1).padStart(3, '0')}`;
    return this.storeRepository.create(store);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/stores/count')
  @response(200, {
    description: 'Store model count',
    content: {'application/json': {schema: CountSchema}},
  })
  async count(@param.where(Store) where?: Where<Store>): Promise<Count> {
    return this.storeRepository.count(where);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/stores')
  @response(200, {
    description: 'Array of Store model instances',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: getModelSchemaRef(Store, {includeRelations: true}),
        },
      },
    },
  })
  async find(@param.filter(Store) filter?: Filter<Store>): Promise<Store[]> {
    return this.storeRepository.find({
      ...filter,
      where: {and: [{isDeleted: false}, filter?.where ?? {}]},
      order: ['createdAt DESC'],
      include: [{relation: 'cluster'}],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @patch('/stores')
  @response(200, {
    description: 'Store PATCH success count',
    content: {'application/json': {schema: CountSchema}},
  })
  async updateAll(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(Store, {partial: true}),
        },
      },
    })
    store: Store,
    @param.where(Store) where?: Where<Store>,
  ): Promise<Count> {
    return this.storeRepository.updateAll(store, where);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/stores/{id}')
  @response(200, {
    description: 'Store model instance',
    content: {
      'application/json': {
        schema: getModelSchemaRef(Store, {includeRelations: true}),
      },
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(Store, {exclude: 'where'})
    filter?: FilterExcludingWhere<Store>,
  ): Promise<Store> {
    return this.storeRepository.findById(id, {
      ...filter,
      include: [{relation: 'cluster'}],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @patch('/stores/{id}')
  @response(204, {description: 'Store PATCH success'})
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(Store, {partial: true}),
        },
      },
    })
    store: Partial<Store>,
  ): Promise<void> {
    await this.storeRepository.updateById(id, store);
  }

  // @authenticate('jwt')
  // @authorize({roles: ['super_admin']})
  // @del('/stores/{id}')
  // @response(204, {description: 'Store DELETE success'})
  // async deleteById(@param.path.string('id') id: string): Promise<void> {
  //   await this.storeRepository.updateById(id, {
  //     isDeleted: true,
  //     isActive: false,
  //     deletedAt: new Date() as any,
  //   } as any);
  // }
}
