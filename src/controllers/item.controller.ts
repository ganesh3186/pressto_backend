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
import { Item } from '../models/item.model';
import { ItemRepository } from '../repositories/item.repository';

export class ItemController {
  constructor(
    @repository(ItemRepository)
    public itemRepository: ItemRepository,
  ) { }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @post('/items')
  @response(200, {
    description: 'Item model instance',
    content: { 'application/json': { schema: getModelSchemaRef(Item) } },
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(Item, {
            title: 'NewItem',
            exclude: ['id', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    item: Omit<Item, 'id'>,
  ): Promise<Item> {
    return this.itemRepository.create(item);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/items/count')
  @response(200, {
    description: 'Item model count',
    content: { 'application/json': { schema: CountSchema } },
  })
  async count(@param.where(Item) where?: Where<Item>): Promise<Count> {
    return this.itemRepository.count(where);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/items')
  @response(200, {
    description: 'Array of Item model instances',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: getModelSchemaRef(Item, { includeRelations: true }),
        },
      },
    },
  })
  async find(@param.filter(Item) filter?: Filter<Item>): Promise<Item[]> {
    return this.itemRepository.find(filter);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @patch('/items')
  @response(200, {
    description: 'Item PATCH success count',
    content: { 'application/json': { schema: CountSchema } },
  })
  async updateAll(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(Item, { partial: true }),
        },
      },
    })
    item: Item,
    @param.where(Item) where?: Where<Item>,
  ): Promise<Count> {
    return this.itemRepository.updateAll(item, where);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/items/{id}')
  @response(200, {
    description: 'Item model instance',
    content: {
      'application/json': {
        schema: getModelSchemaRef(Item, { includeRelations: true }),
      },
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(Item, { exclude: 'where' }) filter?: FilterExcludingWhere<Item>,
  ): Promise<Item> {
    return this.itemRepository.findById(id, filter);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @patch('/items/{id}')
  @response(204, { description: 'Item PATCH success' })
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': { schema: getModelSchemaRef(Item, { partial: true }) },
      },
    })
    item: Item,
  ): Promise<void> {
    await this.itemRepository.updateById(id, item);
  }

  // @authenticate('jwt')
  // @authorize({roles: ['super_admin']})
  // @put('/items/{id}')
  // @response(204, {description: 'Item PUT success'})
  // async replaceById(
  //   @param.path.string('id') id: string,
  //   @requestBody() item: Item,
  // ): Promise<void> {
  //   await this.itemRepository.replaceById(id, item);
  // }

  // @authenticate('jwt')
  // @authorize({roles: ['super_admin']})
  // @del('/items/{id}')
  // @response(204, {description: 'Item DELETE success'})
  // async deleteById(@param.path.string('id') id: string): Promise<void> {
  //   await this.itemRepository.deleteById(id);
  // }
}
