import {BindingScope, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {Store} from '../models';
import {StorePincodeCoverageRepository, StoreRepository} from '../repositories';
import {storeSearchRadiusKm} from '../utils/config';
import {hasRealCoordinates} from './geocoding.service';

const EARTH_RADIUS_KM = 6371;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

function toNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Great-circle (straight-line) distance between two lat/lng points, in km. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export type NearbyStore = {
  id: string;
  name: string;
  code: string;
  distanceKm: number;
  latitude: number;
  longitude: number;
};

/** One store serving a pincode — see StoreAssignmentService.listStoresForPincode. */
export type PincodeStore = {
  id: string;
  name: string;
  storeId?: string;
  storeName?: string;
  code: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  phone: string | null;
  latitude: number | null;
  longitude: number | null;
  /** Distance from the pincode's centroid, from the coverage table; null for a store matched only by its own pincode. */
  centroidDistanceKm: number | null;
  /** Share of the pincode's area in this store's range, from the coverage table. */
  pctOfPincodeInRange: number | null;
  matchedBy: 'coverage' | 'store_pincode';
};

export type ResolvedStore = {
  store: {id: string; name: string; code: string; distanceKm?: number} | null;
  matchedBy: 'coordinates' | 'pincode' | null;
  /** Only populated when nothing matched — closest stores past the radius. */
  nearbyBeyondRadius: NearbyStore[];
};

/**
 * Distance-based store lookup, keyed off Store.latitude/longitude — a
 * live, per-address alternative to the seeded, pincode-level
 * StorePincodeCoverage table (unused anywhere today). Used for:
 *   - auto-assigning a self-registered customer's first address to a
 *     preferredStoreId (CustomerAddressService.create), and
 *   - resolving/blocking a self-service pickup request's storeId
 *     (CustomerProfileController.createPickupRequest).
 * Radius is the shared STORE_SEARCH_RADIUS_KM setting (utils/config.ts)
 * so it can be tuned without a code change; defaults to 15km when unset.
 */
@injectable({scope: BindingScope.TRANSIENT})
export class StoreAssignmentService {
  constructor(
    @repository(StoreRepository) private storeRepo: StoreRepository,
    @repository(StorePincodeCoverageRepository)
    private coverageRepo: StorePincodeCoverageRepository,
  ) {}

  static radiusKm(): number {
    return storeSearchRadiusKm();
  }

  /** Every active store with coordinates, sorted nearest-first. */
  private async sortedByDistance(lat: number, lng: number): Promise<NearbyStore[]> {
    const stores = await this.storeRepo.find({
      where: {isActive: true, isDeleted: false} as object,
      fields: {id: true, name: true, code: true, latitude: true, longitude: true} as object,
    });
    return stores
      .filter(s => s.latitude != null && s.longitude != null)
      .map(s => {
        // Postgres decimal columns come back as strings — fine for the
        // haversine math below (JS coerces), but latitude/longitude are
        // now part of the API response itself (nearbyStores), so they
        // need to actually be JSON numbers, not numeric strings.
        const latitude = Number(s.latitude);
        const longitude = Number(s.longitude);
        return {
          id: s.id,
          name: s.name,
          code: s.code,
          distanceKm: haversineKm(lat, lng, latitude, longitude),
          latitude,
          longitude,
        };
      })
      .sort((a, b) => a.distanceKm - b.distanceKm);
  }

  /**
   * The nearest active store within the configured radius (or null), plus
   * up to `beyondLimit` of the next-nearest stores past it — one store
   * fetch covers both, since the caller usually needs the second only
   * when the first came back empty.
   */
  async resolveForCoordinates(
    lat: number,
    lng: number,
    beyondLimit = 5,
  ): Promise<{nearestWithinRadius: NearbyStore | null; nearbyBeyondRadius: NearbyStore[]}> {
    const sorted = await this.sortedByDistance(lat, lng);
    const radius = StoreAssignmentService.radiusKm();
    const within = sorted.filter(s => s.distanceKm <= radius);
    const beyond = sorted.filter(s => s.distanceKm > radius).slice(0, beyondLimit);
    return {
      nearestWithinRadius: within[0] ?? null,
      nearbyBeyondRadius: beyond,
    };
  }

  async findActiveStore(storeId: string): Promise<Store | null> {
    return this.storeRepo.findOne({
      where: {id: storeId, isActive: true, isDeleted: false} as object,
    });
  }

  /**
   * One-call "which store serves this location" — use coordinates when
   * available and enforce the radius; use pincode coverage only when usable
   * coordinates are unavailable. Same precedence as the customer app's pickup
   * flow (CustomerProfileController.createPickupRequest). Either input may
   * be missing; `store` is null when neither resolves.
   */
  async resolveNearestStore(input: {
    latitude?: number | string | null;
    longitude?: number | string | null;
    pincode?: string | null;
  }): Promise<ResolvedStore> {
    const lat = Number(input.latitude);
    const lng = Number(input.longitude);
    const hasCoords = hasRealCoordinates(input.latitude, input.longitude);

    let nearbyBeyondRadius: NearbyStore[] = [];
    if (hasCoords) {
      const resolved = await this.resolveForCoordinates(lat, lng);
      if (resolved.nearestWithinRadius) {
        const s = resolved.nearestWithinRadius;
        return {
          store: {id: s.id, name: s.name, code: s.code, distanceKm: Number(s.distanceKm.toFixed(2))},
          matchedBy: 'coordinates',
          nearbyBeyondRadius: [],
        };
      }
      nearbyBeyondRadius = resolved.nearbyBeyondRadius;
    }

    if (!hasCoords && input.pincode) {
      const pincodeStore = await this.resolveForPincode(input.pincode);
      if (pincodeStore) {
        return {
          store: {id: pincodeStore.id, name: pincodeStore.name, code: pincodeStore.code},
          matchedBy: 'pincode',
          nearbyBeyondRadius: [],
        };
      }
    }

    return {store: null, matchedBy: null, nearbyBeyondRadius};
  }

  /**
   * Auto-picks a store the same way the rider app's store picker
   * (listStoresForPincode) offers them: when stores serve the pincode, the
   * pick is always one of them — the nearest to the coordinates when known,
   * else the first in the list. resolveNearestStore's coordinate-first
   * lookup can land on a store outside that list, so it is used only when
   * no store serves the pincode. Pass `pincodeStores` when the caller has
   * already listed them.
   */
  async resolveStoreWithinPincode(
    input: {latitude?: number | string | null; longitude?: number | string | null; pincode?: string | null},
    pincodeStores?: PincodeStore[],
  ): Promise<ResolvedStore> {
    const stores = pincodeStores ?? (input.pincode ? await this.listStoresForPincode(input.pincode) : []);
    if (!stores.length) return this.resolveNearestStore(input);

    if (hasRealCoordinates(input.latitude, input.longitude)) {
      const lat = Number(input.latitude);
      const lng = Number(input.longitude);
      const radius = StoreAssignmentService.radiusKm();
      const nearest = stores
        .filter(s => s.latitude != null && s.longitude != null)
        .map(s => ({store: s, distanceKm: haversineKm(lat, lng, s.latitude!, s.longitude!)}))
        .filter(candidate => candidate.distanceKm <= radius)
        .sort((a, b) => a.distanceKm - b.distanceKm)[0];
      if (nearest) {
        const {id, name, code} = nearest.store;
        return {
          store: {id, name, code, distanceKm: Number(nearest.distanceKm.toFixed(2))},
          matchedBy: 'pincode',
          nearbyBeyondRadius: [],
        };
      }
      return this.resolveNearestStore(input);
    }
    const {id, name, code} = stores[0];
    return {store: {id, name, code}, matchedBy: 'pincode', nearbyBeyondRadius: []};
  }

  /**
   * Best guess at the nearest active store using pincodes alone — for when
   * coordinates aren't available (address not geocoded, or stores without
   * latitude/longitude). Indian pincodes share their first 3 digits within
   * a sorting district, so the candidate pincode — one a store covers, or
   * is located in — sharing the longest prefix wins, then the numerically
   * closest, then the coverage table's centroid distance. Null when no
   * store is in the same 3-digit district: beyond it pincode numbers say
   * nothing reliable about distance (401107 Mira Road is numerically
   * closer to Vashi's 400710 than to Kandivali's 400067).
   */
  async nearestStoreByPincode(pincode: string): Promise<{id: string; name: string; code: string} | null> {
    const pin = String(pincode ?? '').trim();
    if (!/^\d{6}$/.test(pin)) return null;
    const region = `${pin.slice(0, 3)}%`;

    const [coverage, located] = await Promise.all([
      this.coverageRepo.find({
        where: {pincode: {like: region}, isActive: true, isDeleted: false} as object,
        fields: {storeId: true, pincode: true, centroidDistanceKm: true} as object,
      }),
      this.storeRepo.find({
        where: {pincode: {like: region}, isActive: true, isDeleted: false} as object,
        fields: {id: true, pincode: true} as object,
      }),
    ]);
    const candidates = [
      ...coverage.map(row => ({storeId: row.storeId, pincode: String(row.pincode), km: Number(row.centroidDistanceKm)})),
      ...located.map(store => ({storeId: store.id, pincode: String(store.pincode).trim(), km: NaN})),
    ].filter(c => /^\d{6}$/.test(c.pincode));
    if (!candidates.length) return null;

    const sharedPrefix = (other: string) => {
      let n = 0;
      while (n < 6 && other[n] === pin[n]) n++;
      return n;
    };
    const ranked = candidates
      .map(c => ({
        ...c,
        prefix: sharedPrefix(c.pincode),
        gap: Math.abs(Number(c.pincode) - Number(pin)),
        km: Number.isFinite(c.km) ? c.km : Infinity,
      }))
      .filter(c => c.prefix >= 3)
      .sort((a, b) => b.prefix - a.prefix || a.gap - b.gap || a.km - b.km);
    if (!ranked.length) return null;

    // Coverage rows can point at stores since closed — take the best active one.
    const stores = await this.storeRepo.find({
      where: {id: {inq: [...new Set(ranked.map(c => c.storeId))]}, isActive: true, isDeleted: false} as object,
      fields: {id: true, name: true, code: true} as object,
    });
    const byId = new Map(stores.map(s => [s.id, s]));
    const best = ranked.map(c => byId.get(c.storeId)).find(Boolean);
    return best ? {id: best.id, name: best.name, code: best.code} : null;
  }

  /** Nearest active store explicitly covering a pincode. */
  async resolveForPincode(pincode: string): Promise<Store | null> {
    const normalized = String(pincode ?? '').trim();
    if (!/^\d{6}$/.test(normalized)) return null;

    const coverage = (await this.coverageRepo.find({
      where: {pincode: normalized, isActive: true, isDeleted: false} as object,
    })).filter(row => {
      const distance = toNumber(row.centroidDistanceKm);
      return distance !== null && distance <= StoreAssignmentService.radiusKm();
    });
    if (!coverage.length) return null;

    coverage.sort((a, b) => {
      const aDistance = Number(a.centroidDistanceKm);
      const bDistance = Number(b.centroidDistanceKm);
      return (Number.isFinite(aDistance) ? aDistance : Infinity) -
        (Number.isFinite(bDistance) ? bDistance : Infinity);
    });

    const stores = await this.storeRepo.find({
      where: {
        id: {inq: coverage.map(row => row.storeId)},
        isActive: true,
        isDeleted: false,
      } as object,
    });
    const byId = new Map(stores.map(store => [store.id, store]));
    return coverage.map(row => byId.get(row.storeId)).find(Boolean) ?? null;
  }

  /**
   * Every active store that serves a pincode, nearest first: the stores the
   * coverage table lists for it within the configured radius, sorted by
   * distance from the pincode's centroid.
   * Empty for an invalid or uncovered pincode. Backs the rider app's store
   * picker on pickup creation.
   */
  async listStoresForPincode(pincode: string): Promise<PincodeStore[]> {
    const normalized = String(pincode ?? '').trim();
    if (!/^\d{6}$/.test(normalized)) return [];

    const coverage = await this.coverageRepo.find({
      where: {pincode: normalized, isActive: true, isDeleted: false} as object,
    });
    const radius = StoreAssignmentService.radiusKm();
    const coverageWithinRadius = coverage.filter(row => {
      const distance = toNumber(row.centroidDistanceKm);
      return distance !== null && distance <= radius;
    });
    const coverageIds = [...new Set(coverageWithinRadius.map(row => row.storeId))];
    if (!coverageIds.length) return [];
    const stores = await this.storeRepo.find({
      where: {
        isActive: true,
        isDeleted: false,
        id: {inq: coverageIds},
      } as object,
    });

    // A store can appear on more than one coverage row; keep its nearest.
    const coverageByStore = new Map<string, {distance: number | null; pct: number | null}>();
    for (const row of coverageWithinRadius) {
      const distance = toNumber(row.centroidDistanceKm);
      const existing = coverageByStore.get(row.storeId);
      if (!existing || (distance ?? Infinity) < (existing.distance ?? Infinity)) {
        coverageByStore.set(row.storeId, {distance, pct: toNumber(row.pctOfPincodeInRange)});
      }
    }

    return stores
      .map((store): PincodeStore => {
        const covered = coverageByStore.get(store.id);
        return {
          id: store.id,
          name: store.name,
          storeId: store.id,
          storeName: store.name,
          code: store.code,
          address: store.address,
          city: store.city,
          state: store.state,
          pincode: store.pincode,
          phone: store.phone ?? null,
          latitude: toNumber(store.latitude),
          longitude: toNumber(store.longitude),
          centroidDistanceKm: covered?.distance ?? null,
          pctOfPincodeInRange: covered?.pct ?? null,
          matchedBy: 'coverage',
        };
      })
      .sort((a, b) => {
        const byDistance = (a.centroidDistanceKm ?? Infinity) - (b.centroidDistanceKm ?? Infinity);
        return byDistance || a.name.localeCompare(b.name);
      });
  }
}
