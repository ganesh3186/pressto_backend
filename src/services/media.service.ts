import {BindingScope, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {MediaRepository} from '../repositories';

@injectable({scope: BindingScope.TRANSIENT})
export class MediaService {
  constructor(
    @repository(MediaRepository)
    private mediaRepository: MediaRepository,
  ) { }

  async updateMediaUsedStatus(mediaIds: string[], usedStatus: boolean) {
    if (!mediaIds?.length) return;

    for (const id of mediaIds) {
      await this.mediaRepository.updateById(id, {isUsed: usedStatus});
    }
  }
}
