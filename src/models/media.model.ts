import {Entity, model, property} from '@loopback/repository';

@model({
  settings: {
    postgresql: {
      table: 'media',
      schema: 'public',
    },
  }
})
export class Media extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {
      dataType: 'uuid',
    },
  })
  id: string;

  @property({
    type: 'string',
    required: true
  })
  fileOriginalName: string;

  @property({
    type: 'string',
    required: true
  })
  fileName: string;

  @property({
    type: 'string',
    required: true
  })
  fileUrl: string;

  @property({
    type: 'string',
    required: true
  })
  fileLocation: string;

  @property({
    type: 'string',
    required: true
  })
  fileType: string;

  @property({
    type: 'boolean',
    default: false,
  })
  isUsed?: boolean;

  @property({
    type: 'date',
    defaultFn: 'now',
  })
  createdAt?: Date;

  @property({
    type: 'date',
    defaultFn: 'now',
  })
  updatedAt?: Date;
  constructor(data?: Partial<Media>) {
    super(data);
  }
}

export interface MediaRelations {
  // describe navigational properties here
}

export type MediaWithRelations = Media & MediaRelations;
