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
import {Store} from '../models/store.model';
import {StoreRepository} from '../repositories/store.repository';

export class StoreController {
  constructor(
    @repository(StoreRepository)
    public storeRepository: StoreRepository,
  ) {}

  // Client-chosen (unlike `code`, which is server-generated), so it needs
  // its own normalize/validate/duplicate-check pass — mirrors the existing
  // duplicate-`name` check below, keyed on `storePrefix` instead.
  // Returns: undefined = field absent from the payload, leave untouched;
  // null = explicitly clearing it (empty string submitted); string = the
  // normalized value to save.
  private async normalizeAndValidateStorePrefix(
    prefix: string | undefined,
    excludeId?: string,
  ): Promise<string | null | undefined> {
    if (prefix === undefined) return undefined;
    const trimmed = prefix.trim().toUpperCase();
    if (!trimmed) return null;
    if (!/^[A-Z0-9]{2,10}$/.test(trimmed)) {
      throw new HttpErrors.BadRequest('Store prefix must be 2-10 letters/numbers.');
    }
    const duplicate = await this.storeRepository.findOne({
      where: {
        storePrefix: trimmed,
        isDeleted: false,
        ...(excludeId ? {id: {neq: excludeId}} : {}),
      } as object,
    });
    if (duplicate) throw new HttpErrors.Conflict(`Store prefix "${trimmed}" is already in use.`);
    return trimmed;
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['store:create']})
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
    store.name = (store.name as string).trim();
    const duplicate = await this.storeRepository.findOne({where: {name: {ilike: store.name}, isDeleted: false}});
    if (duplicate) throw new HttpErrors.Conflict(`A store with name "${store.name}" already exists.`);
    const normalizedPrefix = await this.normalizeAndValidateStorePrefix(store.storePrefix);
    if (normalizedPrefix) store.storePrefix = normalizedPrefix;
    else delete store.storePrefix;
    store.code = `STR${String(maxNum + 1).padStart(3, '0')}`;
    return this.storeRepository.create(store);
  }

  @authenticate('jwt')
  @get('/stores/count')
  @response(200, {
    description: 'Store model count',
    content: {'application/json': {schema: CountSchema}},
  })
  async count(@param.where(Store) where?: Where<Store>): Promise<Count> {
    return this.storeRepository.count(where);
  }

  @authenticate('jwt')
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
  @authorize({roles: ['super_admin'], permissions: ['store:update']})
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
  @authorize({roles: ['super_admin'], permissions: ['store:update']})
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
    if (store.name) {
      store.name = (store.name as string).trim();
      const duplicate = await this.storeRepository.findOne({where: {name: {ilike: store.name}, isDeleted: false, id: {neq: id}} as any});
      if (duplicate) throw new HttpErrors.Conflict(`A store with name "${store.name}" already exists.`);
    }
    if (store.storePrefix !== undefined) {
      // May resolve to `null` (explicit clear) — cast past Partial<Store>'s
      // `string`-only type, same as this codebase's other nullable-clear
      // fields (e.g. Customer.invoiceSpanDays): `undefined` is stripped
      // before reaching the DB, so only an explicit `null` actually clears.
      (store as unknown as {storePrefix?: string | null}).storePrefix =
        await this.normalizeAndValidateStorePrefix(store.storePrefix, id);
    }
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
