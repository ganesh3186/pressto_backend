import {inject} from '@loopback/core';
import {get, oas, param, Response, RestBindings} from '@loopback/rest';
import {OrderSummaryPdfService} from '../services/order-summary-pdf.service';

/** Customer links authenticate with a scoped, expiring signature, not admin JWT. */
export class CustomerDocumentController {
  constructor(
    @inject('services.order-summary-pdf')
    private summaries: OrderSummaryPdfService,
  ) {}

  @get('/documents/order-summaries/{fileName}')
  @oas.response.file()
  async orderSummary(
    @param.path.string('fileName') fileName: string,
    @param.query.string('expires', {required: true}) expires: string,
    @param.query.string('signature', {required: true}) signature: string,
    @inject(RestBindings.Http.RESPONSE) response: Response,
  ): Promise<void> {
    const pdf = await this.summaries.readSigned(fileName, expires, signature);
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader(
      'Content-Disposition',
      'inline; filename="ticket-summary.pdf"',
    );
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.status(200).end(pdf);
  }
}
