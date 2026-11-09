/* eslint-disable @typescript-eslint/no-explicit-any */
import {expect} from '@loopback/testlab';
import {PassThrough} from 'stream';
import {HttpErrors} from '@loopback/rest';
import {ShiftController} from '../controllers/shift.controller';
import {GatewayPaymentController} from '../controllers/gateway-payment.controller';
import {GarmentActionsController} from '../controllers/garment-actions.controller';
import {RiderAssignmentService} from '../services/rider-assignment.service';
import {RazorpayService} from '../services/razorpay.service';
import {MyUserService} from '../services/user-service';
import {JWTService} from '../services/jwt-service';

describe('shift routes with a non-UUID id',()=>{
  it('returns 404 for GET /shifts/collected instead of reaching Postgres',async()=>{
    const controller:any=Object.assign(Object.create(ShiftController.prototype),{
      shiftRepository:{findById:async()=>{throw new Error('invalid input syntax for type uuid');}},
    });
    await expect(controller.findById({},'collected')).to.be.rejectedWith(HttpErrors.NotFound);
    await expect(controller.collected({},'collected')).to.be.rejectedWith(HttpErrors.NotFound);
  });
});

describe('rider availability with a fallback slot id',()=>{
  it('skips the slot lookup and uses the whole day',async()=>{
    const service:any=Object.assign(Object.create(RiderAssignmentService.prototype),{
      pickupDeliverySlotRepository:{findOne:async()=>{throw new Error('should not look up a fallback slot');}},
    });
    const window=await service.resolveSlotWindow('2026-11-04','fallback:10 AM - 12 PM');
    expect(window).to.deepEqual(await service.resolveSlotWindow('2026-11-04'));
  });

  it('still looks up a real slot id',async()=>{
    let looked=false;
    const service:any=Object.assign(Object.create(RiderAssignmentService.prototype),{
      pickupDeliverySlotRepository:{findOne:async()=>{looked=true;return null;}},
    });
    await service.resolveSlotWindow('2026-11-04','8f14e45f-ceea-467a-9575-0b6b2b5c1a11');
    expect(looked).to.be.true();
  });
});

describe('Razorpay webhook acknowledgement (ARC-014)',()=>{
  const signed=(body:string)=>{
    const request:any=new PassThrough();request.headers={'x-razorpay-signature':'sig'};
    request.end(body);return request;
  };
  const captured=JSON.stringify({event:'payment.captured',payload:{payment:{entity:{id:'pay_1',order_id:'order_1'}}}});
  const controllerWith=(handlePaymentCaptured:()=>Promise<void>)=>Object.assign(
    Object.create(GatewayPaymentController.prototype),
    {razorpayService:{verifyWebhookSignature:()=>true,handlePaymentCaptured}},
  ) as any;

  it('acknowledges a signed payload that does not match the link',async()=>{
    const controller=controllerWith(async()=>{throw new HttpErrors.BadRequest('amount does not match');});
    expect(await controller.webhook(signed(captured))).to.deepEqual({received:true});
  });

  it('acknowledges a signed body that is not JSON',async()=>{
    const controller=controllerWith(async()=>undefined);
    expect(await controller.webhook(signed('not json'))).to.deepEqual({received:true});
  });

  it('still fails on a server fault so Razorpay retries',async()=>{
    const controller=controllerWith(async()=>{throw new Error('connection refused');});
    await expect(controller.webhook(signed(captured))).to.be.rejectedWith('connection refused');
  });

  it('still rejects an unsigned call',async()=>{
    const controller:any=Object.assign(Object.create(GatewayPaymentController.prototype),
      {razorpayService:{verifyWebhookSignature:()=>false}});
    await expect(controller.webhook(signed(captured))).to.be.rejectedWith(HttpErrors.BadRequest);
  });
});

describe('garment action concurrency (ARC-007)',()=>{
  it('lets only one of two simultaneous requests on a garment through',async()=>{
    const held=new Set<string>();let created=0;
    const controller:any=Object.assign(Object.create(GarmentActionsController.prototype),{
      storeScopeService:{assertGarmentEditable:async()=>undefined},
      garmentRepo:{findOne:async()=>({id:'g1',status:'in_process'})},
      approvalRequestRepo:{findOne:async()=>(created?{id:'r1'}:null)},
      dataSource:{
        beginTransaction:async()=>{
          let key:string|undefined;
          return {key,rollback:async()=>{if(key)held.delete(key);}, set:(k:string)=>{key=k;}};
        },
        execute:async(_sql:string,params:string[],{transaction}:any)=>{
          if(held.has(params[0]))return [{locked:false}];
          held.add(params[0]);transaction.set(params[0]);return [{locked:true}];
        },
      },
      approvalService:{createRequest:async()=>{await new Promise(r=>setTimeout(r,20));created++;return {id:'r1'};}},
    });
    const results=await Promise.allSettled([
      controller.requestRiskApproval({},'g1',{reason:'thin fabric'}),
      controller.requestRiskApproval({},'g1',{reason:'thin fabric'}),
    ]);
    expect(created).to.equal(1);
    expect(results.map(r=>r.status).sort()).to.deepEqual(['fulfilled','rejected']);
    const failure=results.find(r=>r.status==='rejected') as PromiseRejectedResult;
    expect(failure.reason).to.be.instanceOf(HttpErrors.Conflict);
    expect(held.size).to.equal(0);
    // Once the first finishes, a later request sees its pending request.
    await expect(controller.requestRiskApproval({},'g1',{reason:'again'})).to.be.rejectedWith(/pending/);
  });

  it('releases the lock when the action fails',async()=>{
    let rolledBack=false;
    const controller:any=Object.assign(Object.create(GarmentActionsController.prototype),{
      dataSource:{beginTransaction:async()=>({rollback:async()=>{rolledBack=true;}}),execute:async()=>[{locked:true}]},
    });
    await expect(controller._withGarmentActionLock('g1',async()=>{throw new Error('boom');})).to.be.rejectedWith('boom');
    expect(rolledBack).to.be.true();
  });
});

describe('Razorpay client timeout (BE-016)',()=>{
  it('sets a timeout on the SDK http client',()=>{
    const env={...process.env};
    process.env.RAZORPAY_KEY_ID='key';process.env.RAZORPAY_KEY_SECRET='secret';
    try {
      const service:any=Object.create(RazorpayService.prototype);
      expect(service.client.api.rq.defaults.timeout).to.equal(15000);
    } finally {process.env=env;}
  });
});

describe('auth dead code (ARC-022, ARC-003)',()=>{
  it('rejects an inactive user in verifyCredentials',async()=>{
    const service=new MyUserService(
      {findOne:async()=>({password:'hash',isActive:false})} as any,
      {comparePassword:async()=>true} as any,
    );
    await expect(service.verifyCredentials({email:'a@b.c',password:'x'} as any)).to.be.rejectedWith(HttpErrors.Forbidden);
  });

  it('no longer exposes generateShortToken',()=>{
    expect((JWTService.prototype as any).generateShortToken).to.be.undefined();
  });
});
