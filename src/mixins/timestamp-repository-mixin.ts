import {Constructor} from '@loopback/core';
import {
  Count,
  DataObject,
  Entity,
  EntityCrudRepository,
  Options,
  Where,
} from '@loopback/repository';

let uuidv4: (options?: any, buffer?: Buffer | Uint8Array, offset?: number) => any;

export function TimeStampRepositoryMixin<
  E extends Entity & {id?: string; createdAt?: Date; updatedAt?: Date},
  ID,
  R extends Constructor<EntityCrudRepository<E, ID>>,
>(repository: R) {
  class MixedRepository extends repository {

    async create(entity: DataObject<E>, options?: Options): Promise<E> {
      // Auto-set UUID
      if (!entity.id) {
        const {v4} = await import('uuid');
        entity.id = v4();
      }

      entity.createdAt = new Date();
      entity.updatedAt = new Date();
      return super.create(entity, options);
    }

    async createAll(
      entities: DataObject<E>[],
      options?: Options,
    ): Promise<E[]> {
      const currentTime = new Date();
      const {v4} = await import('uuid');

      entities.forEach(entity => {
        if (!entity.id) {
          entity.id = v4();
        }
        entity.createdAt = currentTime;
        entity.updatedAt = currentTime;
      });

      return super.createAll(entities, options);
    }

    async updateAll(
      data: DataObject<E>,
      where?: Where<E>,
      options?: Options,
    ): Promise<Count> {
      data.updatedAt = new Date();
      return super.updateAll(data, where, options);
    }

    async replaceById(
      id: ID,
      data: DataObject<E>,
      options?: Options,
    ): Promise<void> {
      data.updatedAt = new Date();
      return super.replaceById(id, data, options);
    }
  }

  return MixedRepository;
}
