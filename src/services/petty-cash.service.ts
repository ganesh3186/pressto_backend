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
 * finance + resolved-register ledger, so it can't drift the way a cached
 * counter could. A REJECTED or still-PENDING register entry never debits
 * it; only APPROVED (using approvedAmount, which may be a partial
 * approval — see PettyCashRegisterEntry's own doc comment).
 */
@injectable({scope: BindingScope.TRANSIENT})
export class PettyCashService {
  constructor(
    @repository(PettyCashFinanceEntryRepository) private financeRepo: PettyCashFinanceEntryRepository,
    @repository(PettyCashRegisterEntryRepository) private registerRepo: PettyCashRegisterEntryRepository,
  ) {}

  async computeBalance(storeId: string): Promise<number> {
    const [financeEntries, approvedEntries] = await Promise.all([
      this.financeRepo.find({where: {storeId} as object, fields: {amount: true} as object}),
      this.registerRepo.find({
        where: {storeId, status: PettyCashStatus.APPROVED, isDeleted: false} as object,
        fields: {approvedAmount: true} as object,
      }),
    ]);
    const funded = financeEntries.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    const spent = approvedEntries.reduce((sum, e) => sum + (Number(e.approvedAmount) || 0), 0);
    return Math.max(0, funded - spent);
  }

  /**
   * Real activity within [from, to] for a store — feeds the Shift closing
   * form's pettyCash.recvFromFinance/used/disapprovedAmt fields (a
   * prefill starting point, same "not a silent override" posture as
   * ShiftController.collected()'s cash/banking numbers).
   */
  async computeWindowActivity(storeId: string, from: Date, to: Date): Promise<PettyCashWindowActivity> {
    const [financeEntries, resolvedEntries] = await Promise.all([
      this.financeRepo.find({
        where: {storeId, createdAt: {between: [from, to]}} as object,
        fields: {amount: true} as object,
      }),
      this.registerRepo.find({
        where: {
          storeId,
          isDeleted: false,
          status: {inq: [PettyCashStatus.APPROVED, PettyCashStatus.REJECTED]},
          resolvedAt: {between: [from, to]},
        } as object,
        fields: {approvedAmount: true, disapprovedAmt: true} as object,
      }),
    ]);
    const recvFromFinance = financeEntries.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    const used = resolvedEntries.reduce((sum, e) => sum + (Number(e.approvedAmount) || 0), 0);
    const disapprovedAmt = resolvedEntries.reduce((sum, e) => sum + (Number(e.disapprovedAmt) || 0), 0);
    return {recvFromFinance, used, disapprovedAmt};
  }
}
