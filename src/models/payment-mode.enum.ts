export enum PaymentMode {
  CASH = 'cash',
  UPI = 'upi',
  CARD = 'card',
  NET_BANKING = 'net_banking',
  BANK_TRANSFER = 'bank_transfer',
  CHEQUE = 'cheque',           // requires finance approval before confirming (T-04)
  PDC = 'pdc',                 // post-dated cheque — same approval flow as cheque
  PAY_LATER = 'pay_later',     // customer pays after delivery
  ON_ACCOUNT = 'on_account',   // B2B only — deducted from running deposit balance
  GATEWAY = 'gateway',
  WALLET = 'wallet',           // internal wallet deduction — always creates a PaymentTransaction
  PP_VOUCHER = 'pp_voucher',   // wallet top-up only — staff-confirmed directly, no gateway/approval
}
