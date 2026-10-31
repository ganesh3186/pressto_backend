import {expect} from '@loopback/testlab';
import {UserProfile} from '@loopback/security';
import {OrderService} from '../services/order.service';
import {GarmentController} from '../controllers/garment.controller';

describe('shared garment tag allocation', () => {
  it('uses the global sequence in the caller transaction, preserving eight-digit minimum padding', async () => {
    const transaction = {};
    let next = '10758174';
    const service = Object.assign(Object.create(OrderService.prototype), {
      dataSource: {execute: async (sql: string, args: unknown[], options: object) => {
        expect(sql).to.containEql("nextval('public.garment_tag_seq')::text");
        expect(sql).to.containEql('pg_advisory_xact_lock_shared');
        expect(args).to.eql([]);
        expect(options).to.eql({transaction});
        return [{seq: next}];
      }},
    }) as OrderService;
    expect(await service.getNextGarmentTag({transaction})).to.equal('GT10758174');
    next = '1';
    expect(await service.getNextGarmentTag({transaction})).to.equal('GT00000001');
    next = '100000000';
    expect(await service.getNextGarmentTag({transaction})).to.equal('GT100000000');
  });

  it('fails instead of constructing a tag from an invalid sequence response', async () => {
    const service = Object.assign(Object.create(OrderService.prototype), {
      dataSource: {execute: async () => []},
    }) as OrderService;
    await expect(service.getNextGarmentTag()).to.be.rejectedWith(/allocate a garment tag/);
  });

  it('uses the allocator for delayed creation and only counts garments for the current item', async () => {
    const options = {transaction: {}};
    const tags: string[] = [];
    const service = Object.assign(Object.create(OrderService.prototype), {
      orderItemRepo: {find: async () => [{id: 'item', quantity: 2}]},
      garmentRepo: {
        count: async (where: object) => {
          expect(where).to.eql({orderItemId: 'item', isDeleted: false});
          return {count: 0};
        },
        create: async (row: {garmentTagNumber: string}) => {
          tags.push(row.garmentTagNumber);
          return {id: row.garmentTagNumber};
        },
      },
      getNextGarmentTag: async (actual: object) => {
        expect(actual).to.eql(options);
        return `GT${10758174 + tags.length}`;
      },
      saveGarmentInspection: async () => undefined,
      createUnitAdditionalServices: async () => undefined,
      createUnitAdditionalCharges: async () => undefined,
      garmentStatusHistoryRepo: {create: async () => undefined},
    }) as OrderService;
    const target = service as unknown as {
      autoCreateGarments: (order: string, actor: string, uuid: () => string, tx: object) => Promise<object[]>;
    };
    await target.autoCreateGarments('order', 'staff', () => 'uuid', options.transaction);
    expect(tags).to.eql(['GT10758174', 'GT10758175']);
  });

  it('uses the same allocator for manual garment registration', async () => {
    let tag: string | undefined;
    const controller = Object.assign(Object.create(GarmentController.prototype), {
      orderRepository: {findOne: async () => ({id: 'order', status: 'received_at_store'})},
      orderItemRepository: {findOne: async () => ({id: 'item', quantity: 2})},
      garmentRepository: {
        count: async (where: object) => {
          expect(where).to.eql({orderItemId: 'item', isDeleted: false});
          return {count: 0};
        },
        create: async (row: {garmentTagNumber: string}) => {
          tag = row.garmentTagNumber;
          return {id: 'garment', ...row};
        },
      },
      orderService: {getNextGarmentTag: async () => 'GT10758174'},
      garmentStatusHistoryRepository: {create: async () => undefined},
    }) as GarmentController;
    await controller.registerGarment({} as UserProfile, 'order', 'item', {});
    expect(tag).to.equal('GT10758174');
  });
});
