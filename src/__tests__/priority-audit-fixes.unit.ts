/* eslint-disable @typescript-eslint/no-explicit-any */
import {expect} from '@loopback/testlab';
import {OrderService} from '../services/order.service';
import {DeliveryController} from '../controllers/delivery.controller';
import {GarmentStatus} from '../models/garment-status.enum';
import {DeliveryStatus} from '../models/delivery-status.enum';

describe('batched counter inspection (BE-011)',()=>{
  it('moves garments with one status update and one history insert, one row per hop',async()=>{
    const updates:any[]=[];const inserts:any[][]=[];
    const service:any=Object.assign(Object.create(OrderService.prototype),{
      garmentRepo:{updateAll:async(patch:any,where:any)=>{updates.push({patch,where});return {count:where.id.inq.length};}},
      garmentStatusHistoryRepo:{createAll:async(rows:any[])=>{inserts.push(rows);return rows;}},
    });
    let n=0;
    const moved=await service.stepGarmentsForward([
      {id:'a',status:GarmentStatus.RECEIVED},{id:'b',status:GarmentStatus.IN_INSPECTION},
      {id:'c',status:GarmentStatus.IN_PROCESS},{id:'d',status:GarmentStatus.ON_HOLD},
      {id:'a',status:GarmentStatus.RECEIVED},
    ],GarmentStatus.IN_PROCESS,'staff','Inspected at counter',()=>'h'+(++n));
    expect(moved).to.equal(2);
    expect(updates).to.have.length(1);
    expect(updates[0]).to.deepEqual({patch:{status:GarmentStatus.IN_PROCESS},where:{id:{inq:['a','b']}}});
    expect(inserts).to.have.length(1);
    expect(inserts[0].map((row:any)=>row.garmentId+':'+row.status)).to.deepEqual([
      'a:'+GarmentStatus.IN_INSPECTION,'a:'+GarmentStatus.IN_PROCESS,'b:'+GarmentStatus.IN_PROCESS]);
    // Hops of one garment must not share a timestamp: resuming after a hold
    // restores the latest status by changedAt.
    const [first,second]=inserts[0].filter((row:any)=>row.garmentId==='a').map((row:any)=>row.changedAt.getTime());
    expect(second).to.be.greaterThan(first);
  });

  it('writes nothing when no garment needs to move',async()=>{
    let writes=0;
    const service:any=Object.assign(Object.create(OrderService.prototype),{
      garmentRepo:{updateAll:async()=>{writes++;}},garmentStatusHistoryRepo:{createAll:async()=>{writes++;}},
    });
    expect(await service.stepGarmentsForward([{id:'a',status:GarmentStatus.IN_PROCESS}],
      GarmentStatus.IN_INSPECTION,'staff','x',()=>'h')).to.equal(0);
    expect(writes).to.equal(0);
  });
});

describe('delivery cancellation transaction (ARC-006)',()=>{
  for(const failCustody of [false,true]) it(failCustody?'rolls back the bag release when the custody event fails':'releases the bag and records custody inside the transaction',async()=>{
    let committed=false,rolledBack=false;
    const tx={commit:async()=>{committed=true;},rollback:async()=>{rolledBack=true;}};
    const inTx=(options:any)=>expect(options?.transaction).to.equal(tx);
    const controller:any=Object.assign(Object.create(DeliveryController.prototype),{
      dataSource:{beginTransaction:async()=>tx,execute:async(_sql:string,_params:any[],options:any)=>{inTx(options);return [];}},
      deliveryRepo:{findOne:async(_f:any,options:any)=>{inTx(options);return {id:'d1',status:DeliveryStatus.ASSIGNED,bagId:'bag'};},
        updateById:async(_id:string,_p:any,options:any)=>inTx(options)},
      deliveryOrderRepo:{find:async(_f:any,options:any)=>{inTx(options);return [];}},
      orderRepo:{find:async()=>[]},
      bagRepo:{updateById:async(_id:string,_p:any,options:any)=>inTx(options)},
      custodyEventRepo:{create:async(_row:any,options:any)=>{inTx(options);if(failCustody)throw Error('Custody failed');}},
      notificationService:{notifyRider:async()=>undefined},
    });
    const action=controller.cancel('d1',{} as any);
    if(failCustody) await expect(action).to.be.rejectedWith('Custody failed');else await action;
    expect(committed).to.equal(!failCustody);expect(rolledBack).to.equal(failCustody);
  });
});

describe('order retry storage not migrated yet',()=>{
  it('keeps creating orders without retry protection instead of failing every order',async()=>{
    const missing=Object.assign(new Error('relation "public.order_creation_request" does not exist'),{code:'42P01'});
    const service:any=Object.assign(Object.create(OrderService.prototype),{
      dataSource:{execute:async()=>{throw missing;}},
    });
    // A draft with payment is rejected by validation that runs after the retry
    // check, which proves the missing table no longer aborts the request.
    await expect(service.createOrder({isDraft:true,payments:[{amount:1}]},'staff','retry-key-0000000001'))
      .to.be.rejectedWith('Drafts cannot collect payment.');
  });

  it('still surfaces other database errors',async()=>{
    const service:any=Object.assign(Object.create(OrderService.prototype),{
      dataSource:{execute:async()=>{throw Object.assign(new Error('connection lost'),{code:'57P01'});}},
    });
    await expect(service.createOrder({},'staff','retry-key-0000000001')).to.be.rejectedWith('connection lost');
  });
});
