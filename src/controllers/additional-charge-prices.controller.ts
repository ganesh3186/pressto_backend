import {authenticate} from '@loopback/authentication';
import {repository} from '@loopback/repository';
import {get, HttpErrors, param, response} from '@loopback/rest';
import {
  AdditionalChargeMasterRepository,
  ClusterPriceListRepository,
  ClusterRepository,
  PriceListRepository,
  StorePriceOverrideRepository,
  StoreRepository,
} from '../repositories';

type PriceSource = 'store' | 'cluster' | 'region' | 'base';

interface AdditionalChargePrice {
  additionalChargeId: string;
  name: string;
  code: string | null;
  chargeScope: string;
  chargeType: string;
  isTaxable: boolean;
  defaultAmount: number;
  resolvedAmount: number;
  priceSource: PriceSource;
  appliedPercentage: number | null;
}

export class AdditionalChargePricesController {
  constructor(
    @repository(StoreRepository)
    private storeRepository: StoreRepository,
    @repository(ClusterRepository)
    private clusterRepository: ClusterRepository,
    @repository(StorePriceOverrideRepository)
    private storePriceOverrideRepository: StorePriceOverrideRepository,
    @repository(ClusterPriceListRepository)
    private clusterPriceListRepository: ClusterPriceListRepository,
    @repository(PriceListRepository)
    private priceListRepository: PriceListRepository,
    @repository(AdditionalChargeMasterRepository)
    private additionalChargeMasterRepository: AdditionalChargeMasterRepository,
  ) {}

  // Same store → cluster → region → base waterfall as GET /service-item-prices,
  // but resolved off additionalServicePercentage (not the primary `percentage`
  // column) and applied to Additional Charge Master's defaultAmount instead of
  // ServiceItemMapping's basePrice. Two separate resolved-price catalogs, same
  // waterfall shape, so the frontend can preview both consistently.
  @authenticate('jwt')
  @get('/additional-charge-prices')
  @response(200, {
    description: 'Resolved additional-charge prices for a store',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              additionalChargeId: {type: 'string'},
              name: {type: 'string'},
              code: {type: 'string', nullable: true},
              chargeScope: {type: 'string', enum: ['order', 'item']},
              chargeType: {type: 'string'},
              isTaxable: {type: 'boolean'},
              defaultAmount: {type: 'number'},
              resolvedAmount: {type: 'number'},
              priceSource: {type: 'string', enum: ['store', 'cluster', 'region', 'base']},
              appliedPercentage: {type: 'number', nullable: true},
            },
          },
        },
      },
    },
  })
  async getAdditionalChargePrices(
    @param.query.string('storeId') storeId: string,
  ): Promise<AdditionalChargePrice[]> {
    if (!storeId) {
      throw new HttpErrors.BadRequest('storeId is required');
    }

    // 1. Resolve store → cluster → region chain
    const store = await this.storeRepository.findById(storeId);
    if (!store || store.isDeleted) {
      throw new HttpErrors.NotFound('Store not found');
    }

    const cluster = await this.clusterRepository.findById(store.clusterId);
    if (!cluster || cluster.isDeleted) {
      throw new HttpErrors.UnprocessableEntity('Store has no valid cluster assigned');
    }

    // 2. Walk the price waterfall (stop at first match) — additionalServicePercentage
    // at each level, same priority order as the primary service-item waterfall.
    let priceSource: PriceSource = 'base';
    let appliedPercentage: number | null = null;

    // Priority 1: Store override
    const storeOverride = await this.storePriceOverrideRepository.findOne({
      where: {storeId, isDeleted: false, isActive: true},
    });

    if (storeOverride?.additionalServicePercentage != null) {
      priceSource = 'store';
      appliedPercentage = Number(storeOverride.additionalServicePercentage);
    } else {
      // Priority 2: Cluster price list
      const clusterPriceList = await this.clusterPriceListRepository.findOne({
        where: {clusterId: store.clusterId, isDeleted: false, isActive: true},
      });

      if (clusterPriceList?.additionalServicePercentage != null) {
        priceSource = 'cluster';
        appliedPercentage = Number(clusterPriceList.additionalServicePercentage);
      } else {
        // Priority 3: Region price list
        const regionPriceList = await this.priceListRepository.findOne({
          where: {regionId: cluster.regionId, isDeleted: false, isActive: true},
        });

        if (regionPriceList?.additionalServicePercentage != null) {
          priceSource = 'region';
          appliedPercentage = Number(regionPriceList.additionalServicePercentage);
        }
        // else: priceSource stays 'base', appliedPercentage stays null
      }
    }

    // 3. Fetch all active additional charges
    const charges = await this.additionalChargeMasterRepository.find({
      where: {isDeleted: false, isActive: true},
    });

    // additionalServicePercentage is an UPLIFT on top of defaultAmount (e.g. 30 = +30%).
    // 0 = no change. First match in the store→cluster→region waterfall wins.
    const resolveAmount = (defaultAmount: number) =>
      appliedPercentage !== null
        ? parseFloat((defaultAmount * (1 + appliedPercentage / 100)).toFixed(2))
        : defaultAmount;

    // 4. Apply resolved percentage to each additional charge
    return charges.map(charge => {
      const defaultAmount = Number(charge.defaultAmount);
      return {
        additionalChargeId: charge.id,
        name: charge.name,
        code: charge.code ?? null,
        chargeScope: charge.chargeScope,
        chargeType: charge.chargeType,
        isTaxable: Boolean(charge.isTaxable),
        defaultAmount,
        resolvedAmount: resolveAmount(defaultAmount),
        priceSource,
        appliedPercentage,
      };
    });
  }
}
