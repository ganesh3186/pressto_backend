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

    const ids = [...new Set(mediaIds)];
    for (let offset = 0; offset < ids.length; offset += 500) {
      await this.mediaRepository.updateAll({isUsed: usedStatus}, {id: {inq: ids.slice(offset, offset + 500)}});
    }
  }
}
