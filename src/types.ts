import {RequestHandler} from 'express-serve-static-core';

export type FileUploadHandler = RequestHandler;

export interface RequiredPermissions {
  roles?: string[];
  permissions?: string[];
}

export interface CurrentUser {
  id: string;
  email: string;
  phoneNumber: string;
  roles: string[];
  permissions: string[];
}
