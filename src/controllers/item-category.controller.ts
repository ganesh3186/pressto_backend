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
import { ItemCategory } from '../models/item-category.model';
import { ItemCategoryRepository } from '../repositories/item-category.repository';

export class ItemCategoryController {
  constructor(
    @repository(ItemCategoryRepository)
    public itemCategoryRepository: ItemCategoryRepository,
  ) { }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @post('/item-categories')
  @response(200, {
    description: 'ItemCategory model instance',
    content: { 'application/json': { schema: getModelSchemaRef(ItemCategory) } },
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(ItemCategory, {
            title: 'NewItemCategory',
            exclude: ['id', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    itemCategory: Omit<ItemCategory, 'id'>,
  ): Promise<ItemCategory> {
    return this.itemCategoryRepository.create(itemCategory);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/item-categories/count')
  @response(200, {
    description: 'ItemCategory model count',
    content: { 'application/json': { schema: CountSchema } },
  })
  async count(
    @param.where(ItemCategory) where?: Where<ItemCategory>,
  ): Promise<Count> {
    return this.itemCategoryRepository.count(where);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/item-categories')
  @response(200, {
    description: 'Array of ItemCategory model instances',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: getModelSchemaRef(ItemCategory, { includeRelations: true }),
        },
      },
    },
  })
  async find(
    @param.filter(ItemCategory) filter?: Filter<ItemCategory>,
  ): Promise<ItemCategory[]> {
    return this.itemCategoryRepository.find(filter);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @patch('/item-categories')
  @response(200, {
    description: 'ItemCategory PATCH success count',
    content: { 'application/json': { schema: CountSchema } },
  })
  async updateAll(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(ItemCategory, { partial: true }),
        },
      },
    })
    itemCategory: ItemCategory,
    @param.where(ItemCategory) where?: Where<ItemCategory>,
  ): Promise<Count> {
    return this.itemCategoryRepository.updateAll(itemCategory, where);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/item-categories/{id}')
  @response(200, {
    description: 'ItemCategory model instance',
    content: {
      'application/json': {
        schema: getModelSchemaRef(ItemCategory, { includeRelations: true }),
      },
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(ItemCategory, { exclude: 'where' })
    filter?: FilterExcludingWhere<ItemCategory>,
  ): Promise<ItemCategory> {
    return this.itemCategoryRepository.findById(id, filter);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @patch('/item-categories/{id}')
  @response(204, { description: 'ItemCategory PATCH success' })
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(ItemCategory, { partial: true }),
        },
      },
    })
    itemCategory: ItemCategory,
  ): Promise<void> {
    await this.itemCategoryRepository.updateById(id, itemCategory);
  }

  // @authenticate('jwt')
  // @authorize({roles: ['super_admin']})
  // @put('/item-categories/{id}')
  // @response(204, {description: 'ItemCategory PUT success'})
  // async replaceById(
  //   @param.path.string('id') id: string,
  //   @requestBody() itemCategory: ItemCategory,
  // ): Promise<void> {
  //   await this.itemCategoryRepository.replaceById(id, itemCategory);
  // }

  // @authenticate('jwt')
  // @authorize({roles: ['super_admin']})
  // @del('/item-categories/{id}')
  // @response(204, {description: 'ItemCategory DELETE success'})
  // async deleteById(@param.path.string('id') id: string): Promise<void> {
  //   await this.itemCategoryRepository.deleteById(id);
  // }
}
