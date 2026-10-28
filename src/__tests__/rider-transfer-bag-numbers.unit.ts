import {UserProfile} from '@loopback/security';
import {expect} from '@loopback/testlab';
import {RiderTransferController} from '../controllers/rider-transfer.controller';

describe('rider transfer bag numbers', () => {
  it('lists every distinct bag number and omits the primary bag ID', async () => {
    let transferQuery: {limit?: number} = {};
    const controller = Object.assign(
      Object.create(RiderTransferController.prototype),
      {
        resolveActiveRider: async () => ({id: 'rider-1'}),
        transferRepository: {
          find: async (query: {limit?: number}) => {
            transferQuery = query;
            return [
              {id: 'transfer-1', bagId: 'bag-1', status: 'in_transit'},
              {id: 'transfer-2', bagId: 'bag-3', status: 'rider_assigned'},
            ];
          },
        },
        transferItemRepository: {
          find: async () => [
            {transferId: 'transfer-1', bagId: 'bag-1'},
            {transferId: 'transfer-1', bagId: 'bag-2'},
            {transferId: 'transfer-1', bagId: 'bag-2'},
            {transferId: 'transfer-2'},
          ],
        },
        bagRepository: {
          find: async () => [
            {id: 'bag-1', bagNumber: 101},
            {id: 'bag-2', bagNumber: 102},
            {id: 'bag-3', bagNumber: 103},
          ],
        },
      },
    ) as RiderTransferController;

    const result = (await controller.myTransfers({} as UserProfile)) as {
      transfers: Array<{
        bagId?: string;
        bagNumber?: number;
        bagNumbers: number[];
      }>;
    };

    expect(result.transfers.map(transfer => transfer.bagNumbers)).to.deepEqual([
      [101, 102],
      [103],
    ]);
    expect(transferQuery.limit).to.equal(100);
    expect(result.transfers.map(transfer => transfer.bagId)).to.deepEqual([
      undefined,
      undefined,
    ]);
    expect(result.transfers.map(transfer => transfer.bagNumber)).to.deepEqual([
      undefined,
      undefined,
    ]);
  });
});
