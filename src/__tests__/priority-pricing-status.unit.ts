/* eslint-disable @typescript-eslint/no-explicit-any */
import {expect} from '@loopback/testlab';
import {OrderService} from '../services/order.service';
import {CouponDiscountType} from '../models/coupon-discount-type.enum';
import {OrderStatus} from '../models/order-status.enum';

describe('batched request pricing',()=>{
  it('retains coupon priority and store uplift with one mapping read for repeated lines',async()=>{
    let mappingReads=0;
    const service:any=Object.assign(Object.create(OrderService.prototype),{
      serviceItemMappingRepo:{find:async()=>{mappingReads++;return [
        {serviceId:'s1',itemId:'shirt',basePrice:100},{serviceId:'s2',itemId:'shirt',basePrice:100}];}},
      couponPriceOverrideRepo:{find:async()=>[{serviceId:'s1',itemId:'shirt',couponId:'coupon',overridePrice:80}]},
      storeRepo:{findById:async()=>({id:'store'})},storePriceOverrideRepo:{findOne:async()=>({percentage:10})},
      customerLabelAssignmentRepo:{find:async()=>[{customerLabelId:'group'}]},
      couponRepo:{find:async()=>[{id:'coupon',discountType:CouponDiscountType.PRICE_OVERRIDE,
        startDate:'2020-01-01',endDate:'2100-01-01',storeIds:['store'],customerLabelIds:['group']}]},
    });
    const context=await service.preparePricing('store','customer',[
      {serviceId:'s1',itemId:'shirt',additionalServiceIds:['s2']},{serviceId:'s1',itemId:'shirt'}]);
    const primary=await service.resolvePricing('store','s1','shirt','customer',{context});
    const additional=await service.resolvePricing('store','s2','shirt','customer',{context,additional:true});
    expect(primary.resolvedPrice).to.equal(80);expect(primary.priceSource).to.equal('coupon');
    expect(additional.resolvedPrice).to.equal(110);expect(additional.priceSource).to.equal('store');
    expect(mappingReads).to.equal(1);
  });
});

describe('ordinary order status transaction',()=>{
  for(const failHistory of [false,true]) it(failHistory?'rolls back when history fails':'commits status and history without delivering garments',async()=>{
    let committed=false,rolledBack=false,notified=false;
    const tx={commit:async()=>{committed=true;},rollback:async()=>{rolledBack=true;}};
    const service:any=Object.assign(Object.create(OrderService.prototype),{
      dataSource:{beginTransaction:async()=>tx,execute:async()=>[]},
      orderRepo:{findOne:async()=>({id:'order',status:OrderStatus.QUALITY_CHECK}),updateById:async(_id:string,_patch:object,options:any)=>{expect(options.transaction).to.equal(tx);}},
      statusHistoryRepo:{create:async(_row:object,options:any)=>{expect(options.transaction).to.equal(tx);if(failHistory)throw Error('History failed');}},
      notifyStatusChange:()=>{notified=true;},
    });
    const action=service.changeStatus('order',OrderStatus.READY,'staff');
    if(failHistory) await expect(action).to.be.rejectedWith('History failed');else await action;
    expect(committed).to.equal(!failHistory);expect(rolledBack).to.equal(failHistory);expect(notified).to.equal(!failHistory);
  });
});
