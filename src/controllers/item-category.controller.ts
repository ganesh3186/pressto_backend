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
import { ItemCategory } from '../models/item-category.model';
import { ItemCategoryRepository } from '../repositories/item-category.repository';
import { MediaService } from '../services/media.service';
import { inject } from '@loopback/core';

export class ItemCategoryController {
  constructor(
    @repository(ItemCategoryRepository)
    public itemCategoryRepository: ItemCategoryRepository,
    @inject('service.media.service')
    private mediaService: MediaService,
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
            exclude: ['id', 'code', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    itemCategory: Omit<ItemCategory, 'id'>,
  ): Promise<ItemCategory> {
    const existing = await this.itemCategoryRepository.find({fields: {code: true}});
    let maxNum = 0;
    for (const cat of existing) {
      const match = cat.code?.match(/^ICAT(\d+)$/i);
      if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
    }
    itemCategory.name = (itemCategory.name as string).trim();
    const duplicate = await this.itemCategoryRepository.findOne({where: {name: {ilike: itemCategory.name}, isDeleted: false}});
    if (duplicate) throw new HttpErrors.Conflict(`An item category with name "${itemCategory.name}" already exists.`);
    itemCategory.code = `ICAT${String(maxNum + 1).padStart(3, '0')}`;
    const newItemCategory = await this.itemCategoryRepository.create(itemCategory);
    if (newItemCategory.mediaId) {
      await this.mediaService.updateMediaUsedStatus([newItemCategory.mediaId], true);
    }
    return newItemCategory;
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
    return this.itemCategoryRepository.find({
      ...filter,
      where: {and: [{isDeleted: false}, filter?.where ?? {}]},
      order: ['createdAt DESC'],
      include: [
        { relation: 'media', scope: { fields: { id: true, fileOriginalName: true, fileUrl: true, fileType: true } } }
      ]
    });
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
    return this.itemCategoryRepository.findById(id, {
      ...filter,
      include: [
        { relation: 'media', scope: { fields: { id: true, fileOriginalName: true, fileUrl: true, fileType: true } } }
      ]
    });
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
    itemCategory: Partial<ItemCategory>,
  ): Promise<void> {
    if (itemCategory.name) {
      itemCategory.name = (itemCategory.name as string).trim();
      const duplicate = await this.itemCategoryRepository.findOne({where: {name: {ilike: itemCategory.name}, isDeleted: false, id: {neq: id}} as any});
      if (duplicate) throw new HttpErrors.Conflict(`An item category with name "${itemCategory.name}" already exists.`);
    }
    const oldItemCategory = await this.itemCategoryRepository.findById(id);
    await this.itemCategoryRepository.updateById(id, itemCategory);
    if (itemCategory.mediaId && oldItemCategory.mediaId !== itemCategory.mediaId) {
      if (oldItemCategory.mediaId) {
        await this.mediaService.updateMediaUsedStatus([oldItemCategory.mediaId], false);
      }
      await this.mediaService.updateMediaUsedStatus([itemCategory.mediaId], true);
    }
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
