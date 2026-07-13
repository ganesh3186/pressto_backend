export enum ApprovalActionType {
  APPROVED = 'approved',
  REJECTED = 'rejected',
  // Customer declined the upgrade and wants the garment back, unprocessed.
  REJECTED_AND_RETURN = 'rejected_and_return',
  // Customer declined the upgrade but wants processing to continue on the
  // ORIGINAL service (orderItem.serviceId is left untouched).
  REJECTED_AND_PROCESS = 'rejected_and_process',
}

// The three choices a customer is offered on an upgrade_service request.
export const CUSTOMER_UPGRADE_ACTIONS: ApprovalActionType[] = [
  ApprovalActionType.APPROVED,
  ApprovalActionType.REJECTED_AND_RETURN,
  ApprovalActionType.REJECTED_AND_PROCESS,
];
