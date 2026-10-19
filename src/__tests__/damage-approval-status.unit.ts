import {expect} from '@loopback/testlab';
import {ApprovalRequest} from '../models/approval-request.model';
import {ApprovalRequestType} from '../models/approval-request-type.enum';
import {
  GARMENT_STATUS_TRANSITIONS,
  GarmentStatus,
  isActiveGarmentStatus,
} from '../models/garment-status.enum';
import {ApprovalService} from '../services/approval.service';

describe('damage approval status', () => {
  it('moves an approved damage report from on hold to damaged', async () => {
    const updates: GarmentStatus[] = [];
    const history: GarmentStatus[] = [];
    const service = Object.assign(Object.create(ApprovalService.prototype), {
      garmentRepo: {
        findOne: async () => ({id: 'garment-1', status: GarmentStatus.ON_HOLD}),
        updateById: async (_id: string, update: {status: GarmentStatus}) => {
          updates.push(update.status);
        },
      },
      garmentStatusHistoryRepo: {
        create: async (entry: {status: GarmentStatus}) => {
          history.push(entry.status);
        },
      },
    }) as ApprovalService;

    const applyApproveEffect = Reflect.get(service, '_applyApproveEffect') as (
      request: ApprovalRequest,
      performedBy: string,
    ) => Promise<void>;
    await applyApproveEffect.call(service,
      {
        type: ApprovalRequestType.ITEM_DAMAGED,
        entityType: 'garment',
        entityId: 'garment-1',
      } as ApprovalRequest,
      'approver-1',
    );

    expect(updates).to.eql([GarmentStatus.DAMAGED]);
    expect(history).to.eql([GarmentStatus.DAMAGED]);
    expect(GARMENT_STATUS_TRANSITIONS[GarmentStatus.ON_HOLD]).to.containEql(GarmentStatus.DAMAGED);
    expect(isActiveGarmentStatus(GarmentStatus.DAMAGED)).to.be.false();
  });
});
