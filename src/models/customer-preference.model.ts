import {belongsTo, Entity, model, property} from '@loopback/repository';
import {ColourBleedingChoice} from './colour-bleeding-choice.enum';
import {Customer} from './customer.model';
import {UpgradeServiceChoice} from './upgrade-service-choice.enum';

/**
 * A customer's stored defaults — "do this for all my orders" special
 * instructions plus a handful of auto-approve-style choices. One row per
 * customer, created lazily with defaults on first read (see
 * CustomerPreferenceService.getOrCreate) so every customer implicitly has
 * preferences even before ever saving any.
 *
 * This pass only stores and exposes these choices — they are NOT wired
 * into the approval-request workflow (ApprovalService.createRequest).
 * That system has no customer-facing semantics for item damage today and
 * no colour-bleeding sub-classification at all; auto-resolving real
 * approval requests from these flags is a distinct, larger follow-up.
 */
@model({
  settings: {
    postgresql: {table: 'customer_preference', schema: 'public'},
    indexes: {
      uniqueCustomerPreferenceCustomerId: {keys: ['customerId'], options: {unique: true}},
    },
  },
})
export class CustomerPreference extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @belongsTo(() => Customer)
  customerId: string;

  // When true, a new pickup request that doesn't supply its own
  // remarks/mediaIds falls back to specialInstructions/
  // specialInstructionMediaIds below (checked per field independently).
  @property({type: 'boolean', default: false})
  applyInstructionsToAllOrders?: boolean;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  specialInstructions?: string;

  // Same shape as Order.specialInstructionMediaIds.
  @property({type: 'array', itemType: 'string', postgresql: {dataType: 'jsonb'}})
  specialInstructionMediaIds?: string[];

  @property({type: 'boolean', default: false})
  stainAutoApprove?: boolean;

  @property({type: 'boolean', default: false})
  damageAutoApprove?: boolean;

  @property({
    type: 'string',
    default: ColourBleedingChoice.ASK_EVERY_TIME,
    jsonSchema: {enum: Object.values(ColourBleedingChoice)},
  })
  colourBleedingChoice?: ColourBleedingChoice;

  @property({
    type: 'string',
    default: UpgradeServiceChoice.NOTIFY,
    jsonSchema: {enum: Object.values(UpgradeServiceChoice)},
  })
  upgradeServiceChoice?: UpgradeServiceChoice;

  @property({type: 'boolean', default: false})
  isDeleted?: boolean;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  @property({type: 'date'})
  deletedAt?: Date;

  constructor(data?: Partial<CustomerPreference>) {
    super(data);
  }
}

export interface CustomerPreferenceRelations {}

export type CustomerPreferenceWithRelations = CustomerPreference & CustomerPreferenceRelations;
