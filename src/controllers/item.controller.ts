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
import { Item } from '../models/item.model';
import { ItemRepository } from '../repositories/item.repository';
import { MediaService } from '../services/media.service';
import { inject } from '@loopback/core';

export class ItemController {
  constructor(
    @repository(ItemRepository)
    public itemRepository: ItemRepository,
    @inject('service.media.service')
    private mediaService: MediaService,
  ) { }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['item:create']})
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
            exclude: ['id', 'code', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    item: Omit<Item, 'id'>,
  ): Promise<Item> {
    const existing = await this.itemRepository.find({fields: {code: true}});
    let maxNum = 0;
    for (const it of existing) {
      const match = it.code?.match(/^ITEM(\d+)$/i);
      if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
    }
    item.name = (item.name as string).trim();
    const duplicate = await this.itemRepository.findOne({where: {name: {ilike: item.name}, isDeleted: false}});
    if (duplicate) throw new HttpErrors.Conflict(`An item with name "${item.name}" already exists.`);
    item.code = `ITEM${String(maxNum + 1).padStart(3, '0')}`;
    const newItem = await this.itemRepository.create(item);
    if (newItem.mediaId) {
      await this.mediaService.updateMediaUsedStatus([newItem.mediaId], true);
    }
    return newItem;
  }

  @authenticate('jwt')
  @get('/items/count')
  @response(200, {
    description: 'Item model count',
    content: { 'application/json': { schema: CountSchema } },
  })
  async count(@param.where(Item) where?: Where<Item>): Promise<Count> {
    return this.itemRepository.count(where);
  }

  @authenticate('jwt')
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
    return this.itemRepository.find({
      ...filter,
      where: {and: [{isDeleted: false}, filter?.where ?? {}]},
      order: ['createdAt DESC'],
      include: [
        { relation: 'media', scope: { fields: { id: true, fileOriginalName: true, fileUrl: true, fileType: true } } }
      ]
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['item:update']})
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
    return this.itemRepository.findById(id, {
      ...filter,
      include: [
        { relation: 'media', scope: { fields: { id: true, fileOriginalName: true, fileUrl: true, fileType: true } } }
      ]
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['item:update']})
  @patch('/items/{id}')
  @response(204, { description: 'Item PATCH success' })
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': { schema: getModelSchemaRef(Item, { partial: true }) },
      },
    })
    item: Partial<Item>,
  ): Promise<void> {
    if (item.name) {
      item.name = (item.name as string).trim();
      const duplicate = await this.itemRepository.findOne({where: {name: {ilike: item.name}, isDeleted: false, id: {neq: id}} as any});
      if (duplicate) throw new HttpErrors.Conflict(`An item with name "${item.name}" already exists.`);
    }
    const oldItem = await this.itemRepository.findById(id);
    await this.itemRepository.updateById(id, item);
    if (item.mediaId && oldItem.mediaId !== item.mediaId) {
      if (oldItem.mediaId) {
        await this.mediaService.updateMediaUsedStatus([oldItem.mediaId], false);
      }
      await this.mediaService.updateMediaUsedStatus([item.mediaId], true);
    }
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
