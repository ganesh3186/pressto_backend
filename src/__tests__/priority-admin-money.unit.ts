/* eslint-disable @typescript-eslint/no-explicit-any */
import {expect} from '@loopback/testlab';
import {WalletService} from '../services/wallet.service';
import {SecurityDepositService} from '../services/security-deposit.service';
import {PaymentMode} from '../models/payment-mode.enum';

describe('admin money request atomicity',()=>{
  it('rolls back the recharge request when its wallet credit fails',async()=>{
    const requests:object[]=[];let committed=false,rolledBack=false;
    const tx={commit:async()=>{committed=true;},rollback:async()=>{requests.length=0;rolledBack=true;}};
    const service:any=Object.assign(Object.create(WalletService.prototype),{
      walletRepository:{findOne:async()=>({id:'wallet'})},
      rechargeRequestRepository:{count:async()=>({count:0}),create:async(row:object,options:any)=>{
        expect(options.transaction).to.equal(tx);requests.push(row);return row;}},
      dataSource:{beginTransaction:async()=>tx,execute:async()=>[]},
      credit:async(_wallet:string,_amount:number,_type:unknown,_id:unknown,_remarks:unknown,options:any)=>{
        expect(options.transaction).to.equal(tx);throw Error('Credit failed');},
    });
    await expect(service.adminRecharge('customer',100,PaymentMode.CASH,'staff')).to.be.rejectedWith('Credit failed');
    expect(requests).to.have.length(0);expect(committed).to.equal(false);expect(rolledBack).to.equal(true);
  });
  it('rolls back the top-up request when its security-deposit credit fails',async()=>{
    const requests:object[]=[];let rolledBack=false;
    const tx={commit:async()=>{throw Error('Unexpected commit');},rollback:async()=>{requests.length=0;rolledBack=true;}};
    const service:any=Object.assign(Object.create(SecurityDepositService.prototype),{
      depositRepository:{findOne:async()=>({id:'deposit',status:'active'})},
      topupRequestRepository:{count:async()=>({count:0}),create:async(row:object,options:any)=>{
        expect(options.transaction).to.equal(tx);requests.push(row);return row;}},
      dataSource:{beginTransaction:async()=>tx,execute:async()=>[]},
      addAmount:async(_deposit:string,_amount:number,_type:unknown,_id:unknown,_remarks:unknown,options:any)=>{
        expect(options.transaction).to.equal(tx);throw Error('Credit failed');},
    });
    await expect(service.adminTopup('customer',100,PaymentMode.CASH,'staff')).to.be.rejectedWith('Credit failed');
    expect(requests).to.have.length(0);expect(rolledBack).to.equal(true);
  });
});
