import {expect} from '@loopback/testlab';
import {createHash} from 'crypto';
import {Users} from '../models/users.model';
import {OrderService} from '../services/order.service';
import {literalContains} from '../utils/search-pattern';
import {pageBounds, sqlPage, visibleOrderSql} from '../utils/sql-page';

describe('priority query safety', () => {
  it('rejects unbounded/invalid page requests', () => {
    for (const [limit,skip] of [[0,0],[501,0],[10,-1],[1.5,0]]) expect(() => pageBounds(limit,skip)).to.throw();
    expect(pageBounds(10,0,3)).to.eql({limit:10,skip:20});
  });

  it('keeps SQL page order and full count while hydrating only selected IDs', async () => {
    let filter: unknown;
    let queryText = '';
    const repo = {
      entityClass:{modelName:'ApprovalRequest'},
      dataSource:{connector:{buildWhere: () => ({sql:'WHERE status = ?',params:['pending']}),
        parameterize: (query: {sql:string;params:unknown[]}) => {queryText=query.sql; return query;}},
        execute:async () => [{ids:['b','a'],total:'27'}]},
      find:async (where: unknown) => {filter=where;return [{id:'a'},{id:'b'}];},
    };
    const result=await sqlPage(repo,'approval_request',{},2,10,'EXISTS (SELECT 1 WHERE ?)',[true]);
    expect(result).to.eql({rows:[{id:'b'},{id:'a'}],total:27});
    expect(filter).to.eql({where:{id:{inq:['b','a']}}});
    expect(queryText).to.match(/EXISTS[\s\S]+LIMIT \? OFFSET \?/);
  });

  it('retains totals for an empty out-of-range page without hydrating a whole list', async () => {
    const repo={entityClass:{modelName:'SalesReturn'},dataSource:{connector:{
      buildWhere:()=>({sql:'',params:[]}),parameterize:(query:object)=>query},execute:async()=>[{ids:[],total:27}]},
      find:async()=>{throw new Error('Unexpected hydration');}};
    expect(await sqlPage(repo,'sales_return',{},10,100)).to.eql({rows:[],total:27});
  });

  it('includes transfer grants in order visibility without enumerating order IDs', () => {
    const sql=visibleOrderSql('o');
    expect(sql).to.match(/scope_g\.activetransferid/);
    expect(sql).to.match(/scope_t\.tostoreid = ANY/);
    expect(sql).to.match(/scope_item\.orderid = o.id/);
  });

  it('escapes special search characters as literals, including an unmatched parenthesis', () => {
    expect(literalContains('Pune (REG001')).to.equal('%Pune \\(REG001%');
    expect(literalContains('100%_done')).to.equal('%100\\%\\_done%');
    expect(() => new RegExp(literalContains('Pune (REG001'))).not.to.throw();
  });

  it('hides user secrets in JSON while keeping them available to internal authentication', () => {
    const user=new Users({id:'user',password:'hash',loginOtp:'otp',resetPasswordOtp:'reset',phone:'123'});
    expect(user.password).to.equal('hash');
    const json=JSON.parse(JSON.stringify(user));
    expect(json).not.to.have.property('password');
    expect(json).not.to.have.property('loginOtp');
    expect(json).not.to.have.property('resetPasswordOtp');
    expect(json.phone).to.equal('123');
  });
});

describe('order creation retry contract', () => {
  const input = {customerId:'customer',storeId:'store',items:[]};
  const key = 'request-key-123456';
  it('replays the saved response before pricing, wallet checks or other writes', async () => {
    const fingerprint=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const service=Object.assign(Object.create(OrderService.prototype),{dataSource:{execute:async (_sql:string,params:unknown[])=>{
      expect(params[0]).to.equal(createHash('sha256').update('actor:'+key).digest('hex'));
      return [{fingerprint,response:{order:{id:'existing'},approvalRequests:[]}}];
    }}}) as OrderService;
    const result=await service.createOrder(input as never,'actor',key);
    expect(result).to.eql({order:{id:'existing'},approvalRequests:[],idempotencyReplay:true});
  });
  it('rejects reuse for a changed request instead of creating another paid order', async () => {
    const service=Object.assign(Object.create(OrderService.prototype),{dataSource:{execute:async()=>[{fingerprint:'different',response:{}}]}}) as OrderService;
    await expect(service.createOrder(input as never,'actor',key)).to.be.rejectedWith('Idempotency-Key was already used for a different order.');
  });
});
