import {MiddlewareSequence, RequestContext, RestBindings} from '@loopback/rest';
import {randomUUID} from 'crypto';

export class MySequence extends MiddlewareSequence {
  async handle(context: RequestContext): Promise<void> {
    const {request, response} = context;
    const supplied = request.get('x-request-id');
    const requestId = supplied && /^[a-zA-Z0-9_-]{1,80}$/.test(supplied) ? supplied : randomUUID();
    response.setHeader('x-request-id', requestId);
    context.bind('request.id').to(requestId);
    const started = Date.now();
    response.once('finish', () => {
      // Never record query strings, request bodies, credentials or customer data.
      // A logging failure must never surface as an uncaught exception.
      try {
        console.info(JSON.stringify({event: 'http_request', requestId, method: request.method,
          path: context.getSync(RestBindings.Operation.ROUTE, {optional: true})?.path ?? request.route?.path ?? 'unmatched',
          status: response.statusCode, durationMs: Date.now() - started}));
      } catch {
        // Ignore: the response has already been sent.
      }
    });
    await super.handle(context);
  }
}
