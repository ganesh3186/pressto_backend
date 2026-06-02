import {
  BindingScope,
  config,
  ContextTags,
  injectable,
  Provider,
} from '@loopback/core';
import multer from 'multer';
import {FILE_UPLOAD_SERVICE} from '../keys';
import {FileUploadHandler} from '../types';

/**
 * A provider to return an `Express` request handler from `multer` middleware
 */
@injectable({
  scope: BindingScope.TRANSIENT,
  tags: {[ContextTags.KEY]: FILE_UPLOAD_SERVICE},
})
export class FileUploadProvider implements Provider<FileUploadHandler> {
  constructor(
    @config() private options: multer.Options = {},
  ) {
    if (!this.options.storage) {
      // Default to disk storage with the filename containing a timestamp
      this.options.storage = multer.diskStorage({
        destination: this.options.dest ?? undefined, // Use dest instead of destination
        filename: (req, file, cb) => {
          const timestamp = new Date().toISOString().replace(/[-:.]/g, '');
          const fileName = `${timestamp}_${file.originalname}`;
          cb(null, fileName);
        },
      });
    }
  }

  value(): FileUploadHandler {
    return multer(this.options).any();
  }
}
