import {MethodDecoratorFactory} from '@loopback/metadata';
import {RequiredPermissions} from '../types';

export function authorize(options: RequiredPermissions) {
  return MethodDecoratorFactory.createDecorator<RequiredPermissions>(
    'authorization.metadata',
    options,
  );
}
