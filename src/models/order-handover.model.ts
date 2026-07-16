import {Entity, belongsTo, model, property} from '@loopback/repository';
import {ContactRelationship} from './contact-relationship.enum';
import {CustomerContact} from './customer-contact.model';
import {Order} from './order.model';

// Who physically collected the order at the counter.
export enum HandoverCollectorType {
  // The customer themselves.
  SELF = 'self',
  // A saved household contact (customer_contact).
  CONTACT = 'contact',
  // A member of the customer's family group (customer_family_group_member).
  FAMILY_MEMBER = 'family_member',
  // An ad-hoc person, captured by name/phone on the spot.
  OTHER = 'other',
}

/**
 * In-store handover record — a dispatch document for the counter-pickup case
 * (no rider). One row per completed handover of an order.
 *
 * Collector identity is stored two ways on purpose:
 *   • customerContactId links to the saved contact when there is one, and
 *   • collectorName/Phone/Relationship are ALWAYS a point-in-time snapshot,
 * so the record still reads correctly years later even if the contact is later
 * edited or deleted.
 */
@model({
  settings: {
    postgresql: {table: 'order_handover', schema: 'public'},
    // One active handover per order. (isDeleted lets a mistaken handover be
    // voided and redone without violating this.)
    indexes: {
      uniqueOrderHandover: {
        keys: ['orderId', 'isDeleted'],
        options: {unique: true},
      },
    },
  },
})
export class OrderHandover extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @belongsTo(() => Order)
  orderId: string;

  @property({
    type: 'string',
    required: true,
    jsonSchema: {enum: Object.values(HandoverCollectorType)},
  })
  collectorType: HandoverCollectorType;

  // Set only when collectorType = 'contact'.
  @belongsTo(() => CustomerContact)
  customerContactId?: string;

  // Set only when collectorType = 'family_member'
  // (references customer_family_group_member.id).
  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  familyGroupMemberId?: string;

  // Snapshot of the collector, always populated (even for 'self').
  @property({type: 'string', required: true})
  collectorName: string;

  @property({type: 'string'})
  collectorPhone?: string;

  @property({
    type: 'string',
    jsonSchema: {enum: Object.values(ContactRelationship)},
  })
  collectorRelationship?: ContactRelationship;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  remarks?: string;

  // Staff member who handed the order over (users.id).
  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  handedOverBy: string;

  @property({type: 'date', defaultFn: 'now'})
  handedOverAt?: Date;

  @property({type: 'boolean', default: false})
  isDeleted?: boolean;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  @property({type: 'date'})
  deletedAt?: Date;

  constructor(data?: Partial<OrderHandover>) {
    super(data);
  }
}

export interface OrderHandoverRelations {
  order?: Order;
  customerContact?: CustomerContact;
}

export type OrderHandoverWithRelations = OrderHandover & OrderHandoverRelations;
