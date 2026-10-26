import {expect} from '@loopback/testlab';
import {OrderService} from '../services/order.service';

describe('draft inspection persistence', () => {
  it('replaces an existing draft garment inspection in the save transaction', async () => {
    const tx = {};
    const deleted: string[] = [];
    const created: object[] = [];
    const service = Object.assign(Object.create(OrderService.prototype), {
      garmentStainRepo: {
        find: async () => [{id: 'old-stain'}],
        deleteAll: async (_where: object, options: object) => {
          expect(options).to.eql({transaction: tx}); deleted.push('stain');
        },
        create: async (row: object) => {created.push(row); return {id: 'new-stain'};},
      },
      garmentDamageRepo: {
        find: async () => [{id: 'old-damage'}],
        deleteAll: async () => {deleted.push('damage');},
        create: async (row: object) => {created.push(row); return {id: 'new-damage'};},
      },
      garmentStainImageRepo: {deleteAll: async () => {deleted.push('stain-image');},
        create: async (row: object) => {created.push(row);}},
      garmentDamageImageRepo: {deleteAll: async () => {deleted.push('damage-image');},
        create: async (row: object) => {created.push(row);}},
      garmentImageRepo: {deleteAll: async () => {deleted.push('image');},
        create: async (row: object) => {created.push(row);}},
    }) as OrderService;
    const replace = service as unknown as {replaceDraftGarmentInspection:
      (id: string, unit: object, transaction: object, uuid: () => string) => Promise<void>};
    await replace.replaceDraftGarmentInspection('garment-1', {
      itemPhotoMediaIds: ['photo-1'],
      stainMarks: [{stainId: 'stain-1', mediaIds: ['stain-photo']}],
      damageMarks: [{damageId: 'damage-1', mediaIds: ['damage-photo']}],
    }, tx, () => 'new-id');
    expect(deleted).to.deepEqual(['stain-image', 'damage-image', 'stain', 'damage', 'image']);
    expect(created).to.containDeep([
      {garmentId: 'garment-1', mediaId: 'photo-1'},
      {garmentId: 'garment-1', stainId: 'stain-1'},
      {garmentId: 'garment-1', damageTypeId: 'damage-1'},
    ]);
  });

  it('applies a pickup draft unit snapshot when the garment is received', async () => {
    let savedGarment: object | undefined;
    let savedInspection: object | undefined;
    const unit = {brandId: 'brand-1', colorId: 'color-1', instructions: 'Hang',
      itemPhotoMediaIds: ['photo-1'], stainMarks: [{stainId: 'stain-1'}]};
    const service = Object.assign(Object.create(OrderService.prototype), {
      orderItemRepo: {find: async () => [{id: 'item-1', quantity: 1,
        draftUnitInspections: [unit]}]},
      garmentRepo: {count: async () => ({count: 0}),
        create: async (row: object) => {savedGarment = row; return {id: 'garment-1'};}},
      garmentStatusHistoryRepo: {create: async () => {}},
      saveGarmentInspection: async (_id: string, inspection: object) => {savedInspection = inspection;},
      createUnitAdditionalServices: async () => {},
      createUnitAdditionalCharges: async () => {},
    }) as OrderService;
    const create = service as unknown as {autoCreateGarments:
      (id: string, by: string, uuid: () => string) => Promise<object[]>};
    await create.autoCreateGarments('draft-1', 'staff-1', () => 'new-id');
    expect(savedGarment).to.containEql({brandId: 'brand-1', colorId: 'color-1',
      customerRemarks: 'Hang'});
    expect(savedInspection).to.equal(unit);
  });
});
