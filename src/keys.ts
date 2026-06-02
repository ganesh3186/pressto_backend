import {BindingKey} from '@loopback/core';
import {EmailManager} from './services/email.service';
import {FileUploadHandler} from './types';

/**
 * Binding key for the file upload service
 */
export const FILE_UPLOAD_SERVICE = BindingKey.create<FileUploadHandler>(
  'services.FileUpload',
);

export namespace EmailManagerBindings {
  export const SEND_MAIL = BindingKey.create<EmailManager>(
    'services.email.send',
  );
}

/**
 * Binding key for the storage directory
 */
export const STORAGE_DIRECTORY = BindingKey.create<string>('storage.directory');

