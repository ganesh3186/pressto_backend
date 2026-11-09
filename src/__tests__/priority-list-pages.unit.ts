import {expect} from '@loopback/testlab';
import {UserProfile} from '@loopback/security';
import {TransferController} from '../controllers/transfer.controller';
import {DeliveryController} from '../controllers/delivery.controller';

describe('logistics database pagination', () => {
  const user = {} as UserProfile;
  const scope = {resolve: async () => ({global:true}), narrowStoreIds:async()=>undefined};

  it('passes transfer page bounds to the repository and returns the full count', async () => {
    let captured: unknown;
    const controller=Object.assign(Object.create(TransferController.prototype),{
      storeScopeService:scope, transferRepo:{find:async(filter:unknown)=>{captured=filter;return [{id:'page-row'}];},count:async()=>({count:501})},
      enrichTransfers:async(rows:unknown[])=>rows,
    }) as TransferController;
    const result=await controller.find(user,undefined,undefined,undefined,undefined,undefined,undefined,10,20);
    expect(captured).to.containEql({limit:10,skip:20});
    expect(result).to.eql({transfers:[{id:'page-row'}],total:501,limit:10,skip:20});
  });

  it('keeps Excel export complete over multiple bounded pages', async () => {
    const skips:number[]=[];
    const controller=Object.assign(Object.create(TransferController.prototype),{
      find:async (_user:unknown,_direction:unknown,_status:unknown,rider:unknown,store:unknown,_from:unknown,_to:unknown,limit:number,skip:number)=>{
        expect(rider).to.equal(undefined); expect(store).to.equal('selected-store'); expect(limit).to.equal(500);
        skips.push(skip);return {transfers:Array.from({length:skip===0?500:1},(_,i)=>({id:String(skip+i)})),total:501};
      },
    }) as TransferController;
    const result=await controller.exportTransfers(user,undefined,undefined,'selected-store') as {transfers:object[]};
    expect(result.transfers).to.have.length(501);expect(skips).to.eql([0,500]);
  });

  it('bounds delivery queries while retaining the total for the pager', async () => {
    let captured:unknown;
    const controller=Object.assign(Object.create(DeliveryController.prototype),{
      storeScopeService:scope,deliveryRepo:{find:async(filter:unknown)=>{captured=filter;return [];},count:async()=>({count:32})},
      enrichDeliveries:async(rows:object[])=>rows,
    }) as DeliveryController;
    const result=await controller.find(user,undefined,undefined,undefined,undefined,undefined,10,0,3);
    expect(captured).to.containEql({limit:10,skip:20});
    expect(result).to.containEql({total:32});
  });
});
