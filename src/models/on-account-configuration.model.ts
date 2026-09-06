import {Entity, model, property} from '@loopback/repository';

/**
 * Global default for the On Account "invoice span" — how many days a
 * consolidated on-account invoice's billing cycle covers, stamped as the
 * invoice's dueDate at generation time (see customer-billing.controller.ts's
 * generateOnAccountInvoice). A single-row config table, same convention as
 * WalletConfiguration. A given customer's OWN Customer.invoiceSpanDays, when
 * set, overrides this — see that field's own doc comment.
 */
@model({
  settings: {
    postgresql: {
      table: 'on_account_configuration',
      schema: 'public',
    },
  },
})
export class OnAccountConfiguration extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {dataType: 'uuid'},
  })
  id: string;

  @property({
    type: 'number',
    required: true,
    postgresql: {dataType: 'numeric'},
  })
  defaultInvoiceSpanDays: number;

  @property({type: 'boolean', default: true})
  isActive?: boolean;

  @property({type: 'boolean', default: false})
  isDeleted?: boolean;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  @property({type: 'date'})
  deletedAt?: Date;

  constructor(data?: Partial<OnAccountConfiguration>) {
    super(data);
  }
}

export interface OnAccountConfigurationRelations {}

export type OnAccountConfigurationWithRelations = OnAccountConfiguration &
  OnAccountConfigurationRelations;
