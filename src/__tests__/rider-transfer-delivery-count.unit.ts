import {expect} from '@loopback/testlab';
import {getControllerSpec} from '@loopback/openapi-v3';
import {RequestBodyObject, SchemaObject, validateRequestBody} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {compareItemCounts, RiderTransferController} from '../controllers/rider-transfer.controller';
import {TransferStatus} from '../models/transfer-status.enum';

type Row = Record<string, unknown>;

/** Equality match, with null matching null/undefined — enough for the controller's guarded updates. */
const matches = (row: Row, where: Row) =>
  Object.entries(where).every(([key, value]) =>
    value === null ? row[key] == null : row[key] === value,
  );

function setup(options: {transfer?: Row; items?: number; riderId?: string} = {}) {
  const transfer: Row = {
    id: '11111111-1111-4111-8111-111111111111',
    transitId: 'TR-A-B-1111-1',
    riderId: 'rider-1',
    status: TransferStatus.IN_TRANSIT,
    bagId: 'bag-1',
    itemCount: 10,
    isDeleted: false,
    ...options.transfer,
  };
  const itemCount = options.items ?? 10;
  const events: Row[] = [];
  const updates: Row[] = [];
  let commits = 0;
  let rollbacks = 0;
  const transferRepository = {
    findOne: async () => ({...transfer}),
    findById: async () => ({...transfer}),
    updateAll: async (data: Row, where: Row) => {
      if (!matches(transfer, where)) return {count: 0};
      updates.push(data);
      Object.assign(transfer, data);
      return {count: 1};
    },
  };
  const controller = Object.assign(Object.create(RiderTransferController.prototype), {
    resolveActiveRider: async () => ({id: options.riderId ?? 'rider-1', isActive: true}),
    transferRepository,
    transferItemRepository: {
      count: async () => ({count: itemCount}),
      find: async () => Array.from({length: itemCount}, () => ({bagId: 'bag-1'})),
    },
    bagRepository: {find: async () => []},
    custodyEventRepository: {create: async (event: Row) => { events.push(event); }},
    dataSource: {
      beginTransaction: async () => ({
        commit: async () => { commits++; },
        rollback: async () => { rollbacks++; },
      }),
    },
  }) as RiderTransferController;
  const user = {[securityId]: 'user-1'} as UserProfile;
  const deliver = (body: Row) =>
    controller.updateTransferStatus(user, String(transfer.id), {
      status: TransferStatus.DELIVERED,
      ...body,
    } as never);
  return {controller, transfer, events, updates, user, deliver, counts: () => ({commits, rollbacks})};
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as {statusCode: number; code?: string; details?: unknown; message: string};
  }
  throw new Error('Expected the request to be rejected.');
}

describe('rider transfer delivery item count', () => {
  it('compares counts as matched, short and excess', () => {
    expect(compareItemCounts(10, 10)).to.deepEqual({
      expectedItemCount: 10, deliveredItemCount: 10, difference: 0, countVerificationStatus: 'matched',
    });
    expect(compareItemCounts(10, 8)).to.containDeep({difference: -2, countVerificationStatus: 'short'});
    expect(compareItemCounts(10, 12)).to.containDeep({difference: 2, countVerificationStatus: 'excess'});
  });

  it('records a matched count and completes the delivery in one transaction', async () => {
    const {transfer, events, deliver, counts} = setup();

    const result = await deliver({deliveredItemCount: 10});

    expect(result).to.containDeep({
      status: TransferStatus.DELIVERED,
      expectedItemCount: 10,
      deliveredItemCount: 10,
      difference: 0,
      countVerificationStatus: 'matched',
      discrepancyReason: null,
      storeReviewRequired: false,
    });
    expect(transfer).to.containDeep({
      status: TransferStatus.DELIVERED,
      deliveredByRiderId: 'rider-1',
      deliveredItemCount: 10,
      dispatchedItemCount: 10,
      deliveryCountStatus: 'matched',
      deliveryCountReviewRequired: false,
    });
    expect(transfer.deliveredAt).to.be.instanceOf(Date);
    expect(events).to.have.length(0);
    expect(counts()).to.deepEqual({commits: 1, rollbacks: 0});
  });

  it('rejects a short count without a reason with 422 and the comparison, leaving status unchanged', async () => {
    const {transfer, events, deliver} = setup();

    const error = await rejection(deliver({deliveredItemCount: 8}));

    expect(error.statusCode).to.equal(422);
    expect(error.code).to.equal('DISCREPANCY_REASON_REQUIRED');
    expect(error.details).to.deepEqual({
      expectedItemCount: 10,
      deliveredItemCount: 8,
      difference: -2,
      countVerificationStatus: 'short',
    });
    expect(transfer.status).to.equal(TransferStatus.IN_TRANSIT);
    expect(transfer.deliveredAt).to.be.undefined();
    // The baseline is kept so the retry with a reason compares against the same number.
    expect(transfer.dispatchedItemCount).to.equal(10);
    expect(events).to.have.length(0);
  });

  it('accepts a null reason on a matched count, as Dart and Kotlin clients send it', async () => {
    const {deliver} = setup();
    expect(await deliver({deliveredItemCount: 10, discrepancyReason: null}))
      .to.containDeep({countVerificationStatus: 'matched', discrepancyReason: null});
  });

  it('treats a null reason on a mismatch as missing (422)', async () => {
    const {deliver} = setup();
    const error = await rejection(deliver({deliveredItemCount: 8, discrepancyReason: null}));
    expect(error.statusCode).to.equal(422);
    expect(error.code).to.equal('DISCREPANCY_REASON_REQUIRED');
  });

  it('treats a blank reason as missing', async () => {
    const {deliver} = setup();
    const error = await rejection(deliver({deliveredItemCount: 8, discrepancyReason: '   '}));
    expect(error.statusCode).to.equal(422);
  });

  it('records a short count with a reason and flags it for store review', async () => {
    const {transfer, deliver} = setup();

    const result = await deliver({deliveredItemCount: 8, discrepancyReason: '  Two shirts left at origin  '});

    expect(result).to.containDeep({
      expectedItemCount: 10,
      deliveredItemCount: 8,
      difference: -2,
      countVerificationStatus: 'short',
      discrepancyReason: 'Two shirts left at origin',
      storeReviewRequired: true,
    });
    expect(transfer).to.containDeep({
      status: TransferStatus.DELIVERED,
      deliveredItemCount: 8,
      deliveryCountStatus: 'short',
      deliveryDiscrepancyReason: 'Two shirts left at origin',
      deliveryCountReviewRequired: true,
    });
  });

  it('records an excess count with a reason', async () => {
    const {deliver} = setup();
    const result = await deliver({deliveredItemCount: 12, discrepancyReason: 'Extra items from another order'});
    expect(result).to.containDeep({difference: 2, countVerificationStatus: 'excess', storeReviewRequired: true});
  });

  it('returns the same result for an identical retry without writing again', async () => {
    const {updates, deliver} = setup();
    const first = await deliver({deliveredItemCount: 8, discrepancyReason: 'Two missing'});
    const writes = updates.length;

    const retry = await deliver({deliveredItemCount: 8, discrepancyReason: 'Two missing'});

    expect(retry).to.deepEqual(first);
    expect(updates).to.have.length(writes);
  });

  it('replays a matched delivery even after the store has received the transfer', async () => {
    const {transfer, deliver} = setup();
    const first = await deliver({deliveredItemCount: 10});
    transfer.status = TransferStatus.RECEIVED;
    expect(await deliver({deliveredItemCount: 10})).to.deepEqual(first);
  });

  it('rejects a conflicting update after completion with 409', async () => {
    const {transfer, deliver} = setup();
    await deliver({deliveredItemCount: 8, discrepancyReason: 'Two missing'});

    const differentCount = await rejection(deliver({deliveredItemCount: 9, discrepancyReason: 'Two missing'}));
    const differentReason = await rejection(deliver({deliveredItemCount: 8, discrepancyReason: 'Other reason'}));

    for (const error of [differentCount, differentReason]) {
      expect(error.statusCode).to.equal(409);
      expect(error.code).to.equal('TRANSFER_ALREADY_DELIVERED');
      expect(error.details).to.containDeep({deliveredItemCount: 8, discrepancyReason: 'Two missing'});
    }
    expect(transfer.deliveredItemCount).to.equal(8);
  });

  it('keeps the original baseline on retry even if the manifest changes', async () => {
    const {transfer, deliver} = setup({transfer: {dispatchedItemCount: 10}, items: 7});
    const result = await deliver({deliveredItemCount: 10});
    expect(result).to.containDeep({expectedItemCount: 10, countVerificationStatus: 'matched'});
    expect(transfer.dispatchedItemCount).to.equal(10);
  });

  it('returns 409 and leaves the status unchanged when the baseline is unavailable', async () => {
    const {transfer, events, deliver} = setup({items: 0});

    const error = await rejection(deliver({deliveredItemCount: 0}));

    expect(error.statusCode).to.equal(409);
    expect(error.code).to.equal('DISPATCH_BASELINE_UNAVAILABLE');
    expect(transfer.status).to.equal(TransferStatus.IN_TRANSIT);
    expect(events).to.have.length(0);
  });

  it('validates deliveredItemCount as a non-negative integer (400)', async () => {
    for (const deliveredItemCount of [undefined, null, -1, 1.5, '8', Number.NaN, Infinity, 2147483648]) {
      const {transfer, deliver} = setup();
      const error = await rejection(deliver({deliveredItemCount}));
      expect(error.statusCode).to.equal(400);
      expect(transfer.status).to.equal(TransferStatus.IN_TRANSIT);
    }
    const {deliver} = setup({items: 1});
    expect(await deliver({deliveredItemCount: 0, discrepancyReason: 'Bag empty on arrival'}))
      .to.containDeep({countVerificationStatus: 'short', difference: -1});
  });

  it('only delivers an in-transit transfer assigned to the caller', async () => {
    const notInTransit = await rejection(
      setup({transfer: {status: TransferStatus.RIDER_ASSIGNED}}).deliver({deliveredItemCount: 10}),
    );
    expect(notInTransit.statusCode).to.equal(400);

    const received = await rejection(
      setup({transfer: {status: TransferStatus.RECEIVED}}).deliver({deliveredItemCount: 10}),
    );
    expect(received.statusCode).to.equal(409);
    expect(received.code).to.equal('TRANSFER_ALREADY_RECEIVED');

    const otherRider = await rejection(setup({riderId: 'rider-2'}).deliver({deliveredItemCount: 10}));
    expect(otherRider.statusCode).to.equal(403);
  });

  it('replays the stored result when an identical concurrent request wins the race', async () => {
    const ctx = setup();
    // Simulate the other request committing between this one's read and write.
    const originalFindOne = (ctx.controller as unknown as {transferRepository: {findOne: () => Promise<Row>}})
      .transferRepository.findOne;
    let raced = false;
    (ctx.controller as unknown as {transferRepository: {findOne: () => Promise<Row>}}).transferRepository.findOne =
      async () => {
        const snapshot = await originalFindOne();
        if (!raced) {
          raced = true;
          Object.assign(ctx.transfer, {
            status: TransferStatus.DELIVERED,
            deliveredAt: new Date(),
            deliveredByRiderId: 'rider-1',
            deliveredItemCount: 10,
            dispatchedItemCount: 10,
            deliveryCountStatus: 'matched',
            deliveryCountReviewRequired: false,
          });
        }
        return snapshot;
      };

    const result = await ctx.deliver({deliveredItemCount: 10});

    expect(result).to.containDeep({countVerificationStatus: 'matched', deliveredItemCount: 10});
    expect(ctx.updates).to.have.length(0);
    expect(ctx.counts()).to.deepEqual({commits: 1, rollbacks: 0});
  });

  it('still accepts the existing in_transit payload (status + bagIds)', async () => {
    const {controller, transfer, user} = setup({transfer: {status: TransferStatus.RIDER_ASSIGNED}});

    const result = await controller.updateTransferStatus(user, String(transfer.id), {
      status: TransferStatus.IN_TRANSIT,
      bagIds: ['bag-1'],
    });

    expect(result).to.containDeep({message: 'Transfer marked in transit.', riderVerifiedItemCount: null});
    expect(transfer.status).to.equal(TransferStatus.IN_TRANSIT);
  });

  it('treats a null itemCount on in_transit as not sent', async () => {
    const {controller, transfer, user} = setup({transfer: {status: TransferStatus.RIDER_ASSIGNED}});
    const result = await controller.updateTransferStatus(user, String(transfer.id), {
      status: TransferStatus.IN_TRANSIT,
      bagIds: ['bag-1'],
      itemCount: null,
    });
    expect(result).to.containDeep({riderVerifiedItemCount: null, shortageCount: null});
    expect(transfer.status).to.equal(TransferStatus.IN_TRANSIT);
  });

  it('rejects an in_transit request without bagIds as before (422)', async () => {
    const {controller, transfer, user} = setup({transfer: {status: TransferStatus.RIDER_ASSIGNED}});
    const error = await rejection(
      controller.updateTransferStatus(user, String(transfer.id), {status: TransferStatus.IN_TRANSIT} as never),
    );
    expect(error.statusCode).to.equal(422);
    expect(transfer.status).to.equal(TransferStatus.RIDER_ASSIGNED);
  });
});

describe('PATCH /rider/transfers/{id}/status request body schema', () => {
  // The schema LoopBack validates every request against, read from the controller itself.
  const operation = (getControllerSpec(RiderTransferController).paths as Record<
    string,
    Record<string, {requestBody: RequestBodyObject}>
  >)['/rider/transfers/{id}/status'].patch;
  const requestBody = operation.requestBody;
  const schema = requestBody.content['application/json'].schema as SchemaObject;
  const validate = (value: object) => validateRequestBody({value, schema}, requestBody, {});
  const bagId = '11111111-1111-4111-8111-111111111111';

  it('accepts the existing in_transit payload and the new delivered payloads', async () => {
    await validate({status: 'in_transit', bagIds: [bagId]});
    await validate({status: 'in_transit', bagIds: [bagId], itemCount: 10});
    await validate({status: 'delivered', deliveredItemCount: 10});
    await validate({status: 'delivered', deliveredItemCount: 8, discrepancyReason: 'Two missing'});
  });

  it('accepts null for every optional field, as Dart and Kotlin clients serialise them', async () => {
    await validate({status: 'delivered', deliveredItemCount: 10, discrepancyReason: null, bagIds: null, itemCount: null});
    await validate({status: 'in_transit', bagIds: [bagId], itemCount: null, deliveredItemCount: null, discrepancyReason: null});
  });

  it('still rejects unknown statuses and wrong types with 422', async () => {
    for (const body of [
      {status: 'received'},
      {deliveredItemCount: 10},
      {status: 'delivered', deliveredItemCount: 8, discrepancyReason: 5},
      {status: 'in_transit', bagIds: ['not-a-uuid']},
      {status: 'in_transit', bagIds: [bagId], itemCount: -1},
    ]) {
      const error = await rejection(validate(body));
      expect(error.statusCode).to.equal(422);
    }
  });
});
