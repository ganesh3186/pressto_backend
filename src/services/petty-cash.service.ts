import {BindingScope, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {PettyCashStatus} from '../models/petty-cash-status.enum';
import {PettyCashFinanceEntryRepository, PettyCashRegisterEntryRepository} from '../repositories';

export interface PettyCashWindowActivity {
  recvFromFinance: number;
  used: number;
  disapprovedAmt: number;
}

/**
 * Shared petty cash math — used by PettyCashController directly and by
 * ShiftController (opening's "supposed" balance, closing's real
 * recvFromFinance/used/disapprovedAmt prefill). Kept as one service rather
 * than duplicated in both controllers, same reasoning as OrderService
 * being the one place order-total math lives.
 *
 * The balance itself is never stored — always computed live from the
 * finance + register ledger, so it can't drift the way a cached counter
 * could. A submitted (PENDING) expense reserves its full requested amount
 * against the balance immediately — the money is "spoken for" the moment
 * it's claimed, not just once a manager gets to it — so a second expense
 * can't be submitted against cash that's already committed elsewhere.
 * REJECTED contributes nothing (the reservation is released in full).
 * APPROVED contributes only approvedAmount, which may be a partial
 * approval (see PettyCashRegisterEntry's own doc comment) — the
 * disapproved remainder is released back the moment it's resolved, simply
 * by no longer counting the full PENDING amount.
 */
@injectable({scope: BindingScope.TRANSIENT})
export class PettyCashService {
  constructor(
    @repository(PettyCashFinanceEntryRepository) private financeRepo: PettyCashFinanceEntryRepository,
    @repository(PettyCashRegisterEntryRepository) private registerRepo: PettyCashRegisterEntryRepository,
  ) {}

  async computeBalance(storeId: string): Promise<number> {
    const [financeEntries, registerEntries] = await Promise.all([
      this.financeRepo.find({where: {storeId} as object, fields: {amount: true} as object}),
      this.registerRepo.find({
        where: {
          storeId,
          isDeleted: false,
          status: {inq: [PettyCashStatus.PENDING, PettyCashStatus.APPROVED]},
        } as object,
        fields: {status: true, amount: true, approvedAmount: true} as object,
      }),
    ]);
    const funded = financeEntries.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    const committed = registerEntries.reduce((sum, e) => {
      const held = e.status === PettyCashStatus.APPROVED ? Number(e.approvedAmount) : Number(e.amount);
      return sum + (held || 0);
    }, 0);
    return Math.max(0, funded - committed);
  }

  /**
   * Real activity within [from, to] for a store — feeds the Shift closing
   * form's pettyCash.recvFromFinance/used/disapprovedAmt fields (a
   * prefill starting point, same "not a silent override" posture as
   * ShiftController.collected()'s cash/banking numbers).
   *
   * `used` = total *submitted* this window (createdAt-scoped), any status
   * — not "approved this window". Since computeBalance() now reserves an
   * expense's full amount the moment it's submitted, that's the number
   * that actually moved the balance during this shift; an entry can be
   * submitted and resolved in different shifts, so scoping `used` by
   * resolution would double-count or miss money depending on timing.
   * `disapprovedAmt` stays resolvedAt-scoped — releasing a reservation
   * only happens at resolution, whichever shift that falls in.
   *
   * ShiftController.recalcClosingDerived's formula
   * (prevSupposed + recvFromFinance − used + disapprovedAmt) relies on
   * this exact split to reconstruct the same number computeBalance()
   * would return live — see that method's own comment for the full
   * derivation.
   */
  async computeWindowActivity(storeId: string, from: Date, to: Date): Promise<PettyCashWindowActivity> {
    const [financeEntries, submittedEntries, resolvedEntries] = await Promise.all([
      this.financeRepo.find({
        where: {storeId, createdAt: {between: [from, to]}} as object,
        fields: {amount: true} as object,
      }),
      this.registerRepo.find({
        where: {storeId, isDeleted: false, createdAt: {between: [from, to]}} as object,
        fields: {amount: true} as object,
      }),
      this.registerRepo.find({
        where: {
          storeId,
          isDeleted: false,
          status: {inq: [PettyCashStatus.APPROVED, PettyCashStatus.REJECTED]},
          resolvedAt: {between: [from, to]},
        } as object,
        fields: {disapprovedAmt: true} as object,
      }),
    ]);
    const recvFromFinance = financeEntries.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    const used = submittedEntries.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    const disapprovedAmt = resolvedEntries.reduce((sum, e) => sum + (Number(e.disapprovedAmt) || 0), 0);
    return {recvFromFinance, used, disapprovedAmt};
  }
}
