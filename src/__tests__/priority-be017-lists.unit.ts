/* eslint-disable @typescript-eslint/no-explicit-any */
import {expect} from '@loopback/testlab';
import {RiderAttendanceController} from '../controllers/rider-attendance.controller';
import {TransferController} from '../controllers/transfer.controller';
import {CustomerBillingController} from '../controllers/customer-billing.controller';
import {RiderPickupController} from '../controllers/rider-pickup.controller';
import {StoreScopeService} from '../services/store-scope.service';

describe('rider attendance date range',()=>{
  it('applies both bounds as separate clauses and keeps the whole end day',async()=>{
    let where:any;
    const controller:any=Object.assign(Object.create(RiderAttendanceController.prototype),{
      attendanceRepository:{find:async(filter:any)=>{where=filter.where;return [];}},
      mediaUrlMap:async()=>({}),
    });
    await controller.listForRider('rider-1','2026-11-01','2026-11-30');
    expect(where.and).to.deepEqual([{riderId:'rider-1'},{isDeleted:false},
      {punchInAt:{gte:new Date('2026-11-01')}},{punchInAt:{lte:new Date('2026-11-30T23:59:59.999Z')}}]);
  });
});

describe('BE-017 lists without application-built ID lists',()=>{
  it('filters the custody report in one SQL query, scoped, and keeps its newest-first order',async()=>{
    let sql='',params:any[]=[];
    const controller:any=Object.assign(Object.create(TransferController.prototype),{
      storeScopeService:{resolve:async()=>({global:false,storeIds:['store-a']})},
      dataSource:{execute:async(text:string,values:any[])=>{sql=text;params=values;return [{id:'e2'},{id:'e1'}];}},
      custodyEventRepo:{find:async()=>[{id:'e1',transferId:'t1'},{id:'e2',transferId:'t1'}]},
      transferRepo:{find:async()=>[{id:'t1',transitId:'TR-1'}]},
      usersRepo:{find:async()=>[]},bagRepo:{find:async()=>[]},
    });
    const result=await controller.listCustodyEvents({},'TAG-9',undefined,'store-a','2026-11-01','2026-11-03');
    expect(sql).to.match(/garmenttagnumber = \$1/);
    expect(sql).to.match(/t\.createdat >= \$3 AND t\.createdat <= \$4/);
    expect(sql).to.match(/ANY\(\$5::uuid\[\]\)/);
    expect(params).to.deepEqual(['TAG-9','store-a',new Date('2026-11-01'),new Date('2026-11-03T23:59:59.999Z'),['store-a']]);
    expect(result.events.map((e:any)=>e.id)).to.deepEqual(['e2','e1']);
    expect(result.events[0].transitId).to.equal('TR-1');
  });

  it('resolves transfer-granted orders with one join, not a list of every received transfer',async()=>{
    const calls:string[]=[];
    const service:any=Object.assign(Object.create(StoreScopeService.prototype),{
      orderRepo:{execute:async(sql:string)=>{calls.push(sql);return [{orderId:'o1'},{orderId:'o2'}];}},
      transferRepo:{find:async()=>{throw new Error('should not list transfers');}},
    });
    expect(await service.transferGrantedOrderIds(['store-a'])).to.deepEqual(['o1','o2']);
    expect(calls).to.have.length(1);
    expect(calls[0]).to.match(/JOIN public\.transfer t ON t\.id = g\.activetransferid/);
  });

  it('matches rider customer search by phone inside one bounded SQL page',async()=>{
    let pageSql='',pageParams:any[]=[];
    const controller:any=Object.assign(Object.create(RiderPickupController.prototype),{
      usersRepository:{find:async()=>{throw new Error('should not list users');}},
      customerRepository:{
        entityClass:{modelName:'Customer'},
        dataSource:{connector:{buildWhere:()=>({sql:'WHERE isdeleted = false',params:[]}),
          parameterize:(q:any)=>q},execute:async(sql:string,params:any[])=>{pageSql=sql;pageParams=params;return [{total:1,ids:['c1']}];}},
        find:async()=>[{id:'c1',firstName:'Asha'}],
      },
    });
    const rows=await controller.searchCustomers('98');
    expect(rows.map((r:any)=>r.id)).to.deepEqual(['c1']);
    expect(pageSql).to.match(/u\.phone ILIKE \?/);
    expect(pageParams.slice(-2)).to.deepEqual([20,0]);
  });

  it('chunks a large on-account customer history instead of one oversized IN list',async()=>{
    const batchSizes:number[]=[];
    const orders=Array.from({length:4500},(_,i)=>({id:'o'+i,orderNumber:i}));
    const controller:any=Object.assign(Object.create(CustomerBillingController.prototype),{
      customerRepo:{findOne:async()=>({id:'c1'})},
      orderRepo:{find:async()=>orders},
      invoiceRepo:{find:async(filter:any)=>{const ids=filter.where.orderId.inq;batchSizes.push(ids.length);
        return ids[0]==='o0'?[{id:'i1',orderId:'o0',balanceDue:40,totalAmount:40,amountReceived:0}]:[];}},
    });
    const result=await controller.pendingInvoices('c1');
    expect(batchSizes).to.deepEqual([2000,2000,500]);
    expect(result.totalDue).to.equal(40);
  });
});
