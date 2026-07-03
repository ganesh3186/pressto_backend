import {authenticate} from '@loopback/authentication';
import {repository} from '@loopback/repository';
import {get, HttpErrors, param, response} from '@loopback/rest';
import {
  ClusterPriceListRepository,
  ClusterRepository,
  PriceListRepository,
  ServiceItemMappingRepository,
  StorePriceOverrideRepository,
  StoreRepository,
} from '../repositories';
import {ServiceRepository} from '../repositories/service.repository';

type PriceSource = 'store' | 'cluster' | 'region' | 'base';

interface AdditionalServicePrice {
  serviceId: string;
  serviceName: string;
  serviceCode: string;
  basePrice: number;
  resolvedPrice: number;
  estimatedDurationInDays: number | null;
}

interface ServiceItemPrice {
  serviceItemMappingId: string;
  serviceId: string;
  itemId: string;
  basePrice: number;
  resolvedPrice: number;
  priceSource: PriceSource;
  appliedPercentage: number | null;
  estimatedDurationInDays: number | null;
  additionalServices: AdditionalServicePrice[];
}

export class ServiceItemPricesController {
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
    @repository(ServiceItemMappingRepository)
    private serviceItemMappingRepository: ServiceItemMappingRepository,
    @repository(ServiceRepository)
    private serviceRepository: ServiceRepository,
  ) {}

  @authenticate('jwt')
  @get('/service-item-prices')
  @response(200, {
    description: 'Resolved service-item prices for a store',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              serviceItemMappingId: {type: 'string'},
              serviceId: {type: 'string'},
              itemId: {type: 'string'},
              basePrice: {type: 'number'},
              resolvedPrice: {type: 'number'},
              priceSource: {type: 'string', enum: ['store', 'cluster', 'region', 'base']},
              appliedPercentage: {type: 'number', nullable: true},
              estimatedDurationInDays: {type: 'number', nullable: true},
              additionalServices: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    serviceId: {type: 'string'},
                    serviceName: {type: 'string'},
                    serviceCode: {type: 'string'},
                    basePrice: {type: 'number'},
                    resolvedPrice: {type: 'number'},
                    estimatedDurationInDays: {type: 'number', nullable: true},
                  },
                },
              },
            },
          },
        },
      },
    },
  })
  async getServiceItemPrices(
    @param.query.string('storeId') storeId: string,
  ): Promise<ServiceItemPrice[]> {
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

    // 2. Walk the price waterfall (stop at first match)
    let priceSource: PriceSource = 'base';
    let appliedPercentage: number | null = null;

    // Priority 1: Store override
    const storeOverride = await this.storePriceOverrideRepository.findOne({
      where: {storeId, isDeleted: false, isActive: true},
    });

    if (storeOverride) {
      priceSource = 'store';
      appliedPercentage = Number(storeOverride.percentage);
    } else {
      // Priority 2: Cluster price list
      const clusterPriceList = await this.clusterPriceListRepository.findOne({
        where: {clusterId: store.clusterId, isDeleted: false, isActive: true},
      });

      if (clusterPriceList) {
        priceSource = 'cluster';
        appliedPercentage = Number(clusterPriceList.percentage);
      } else {
        // Priority 3: Region price list
        const regionPriceList = await this.priceListRepository.findOne({
          where: {regionId: cluster.regionId, isDeleted: false, isActive: true},
        });

        if (regionPriceList) {
          priceSource = 'region';
          appliedPercentage = Number(regionPriceList.percentage);
        }
        // else: priceSource stays 'base', appliedPercentage stays null
      }
    }

    // 3. Fetch all active service-item mappings and services in parallel
    const [mappings, services] = await Promise.all([
      this.serviceItemMappingRepository.find({where: {isDeleted: false, isActive: true}}),
      this.serviceRepository.find({where: {isDeleted: false, isActive: true}}),
    ]);

    // Build lookup maps
    const serviceLookup = new Map(services.map(s => [s.id, s]));
    // Key: `${serviceId}:${itemId}` → mapping (for resolving additional service prices)
    const mappingLookup = new Map(mappings.map(m => [`${m.serviceId}:${m.itemId}`, m]));

    const resolvePrice = (basePrice: number) =>
      appliedPercentage !== null
        ? parseFloat((basePrice * (appliedPercentage / 100)).toFixed(2))
        : basePrice;

    // 4. Apply resolved percentage to each mapping and hydrate additional services
    return mappings.map(mapping => {
      const basePrice = Number(mapping.basePrice);

      const additionalServices: AdditionalServicePrice[] = (mapping.additionalServiceIds ?? [])
        .map(additionalServiceId => {
          const svc = serviceLookup.get(additionalServiceId);
          const addMapping = mappingLookup.get(`${additionalServiceId}:${mapping.itemId}`);
          if (!svc || !addMapping) return null;
          const addBase = Number(addMapping.basePrice);
          return {
            serviceId: additionalServiceId,
            serviceName: svc.name,
            serviceCode: svc.code,
            basePrice: addBase,
            resolvedPrice: resolvePrice(addBase),
            estimatedDurationInDays: addMapping.estimatedDurationInDays ?? null,
          };
        })
        .filter((s): s is AdditionalServicePrice => s !== null);

      return {
        serviceItemMappingId: mapping.id,
        serviceId: mapping.serviceId,
        itemId: mapping.itemId,
        basePrice,
        resolvedPrice: resolvePrice(basePrice),
        priceSource,
        appliedPercentage,
        estimatedDurationInDays: mapping.estimatedDurationInDays ?? null,
        additionalServices,
      };
    });
  }
}
