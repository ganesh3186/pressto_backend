import {BindingScope, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {ColourBleedingChoice} from '../models/colour-bleeding-choice.enum';
import {CustomerPreference} from '../models/customer-preference.model';
import {UpgradeServiceChoice} from '../models/upgrade-service-choice.enum';
import {CustomerPreferenceHistoryRepository, CustomerPreferenceRepository} from '../repositories';

// Fields a customer may PATCH — kept in one place so update() knows
// exactly what to diff/history, without accidentally letting a caller
// overwrite id/customerId/timestamps.
export type CustomerPreferenceChanges = Partial<
  Pick<
    CustomerPreference,
    | 'applyInstructionsToAllOrders'
    | 'specialInstructions'
    | 'specialInstructionMediaIds'
    | 'stainAutoApprove'
    | 'damageAutoApprove'
    | 'colourBleedingChoice'
    | 'upgradeServiceChoice'
  >
>;

@injectable({scope: BindingScope.TRANSIENT})
export class CustomerPreferenceService {
  constructor(
    @repository(CustomerPreferenceRepository)
    private preferenceRepository: CustomerPreferenceRepository,
    @repository(CustomerPreferenceHistoryRepository)
    private historyRepository: CustomerPreferenceHistoryRepository,
  ) {}

  async getOrCreate(customerId: string): Promise<CustomerPreference> {
    const existing = await this.preferenceRepository.findOne({
      where: {customerId, isDeleted: false} as object,
    });
    if (existing) return existing;

    const {v4} = await import('uuid');
    return this.preferenceRepository.create({
      id: v4(),
      customerId,
      applyInstructionsToAllOrders: false,
      stainAutoApprove: false,
      damageAutoApprove: false,
      colourBleedingChoice: ColourBleedingChoice.ASK_EVERY_TIME,
      upgradeServiceChoice: UpgradeServiceChoice.NOTIFY,
    });
  }

  async update(customerId: string, changes: CustomerPreferenceChanges, changedBy: string): Promise<CustomerPreference> {
    const current = await this.getOrCreate(customerId);

    const {v4} = await import('uuid');
    const toApply: Partial<CustomerPreference> = {};

    for (const key of Object.keys(changes) as (keyof CustomerPreferenceChanges)[]) {
      const newValue = changes[key];
      if (newValue === undefined) continue;

      const oldValue = current[key];
      if (this.stringify(oldValue) === this.stringify(newValue)) continue;

      toApply[key] = newValue as never;
      await this.historyRepository.create({
        id: v4(),
        customerId,
        settingKey: key,
        oldValue: this.stringify(oldValue),
        newValue: this.stringify(newValue),
        changedBy,
      });
    }

    if (Object.keys(toApply).length === 0) return current;

    await this.preferenceRepository.updateById(current.id, toApply);
    return this.preferenceRepository.findById(current.id);
  }

  async getHistory(customerId: string) {
    return this.historyRepository.find({
      where: {customerId} as object,
      order: ['changedAt DESC'],
    });
  }

  private stringify(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
}
