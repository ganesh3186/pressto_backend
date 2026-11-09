import {BindingScope, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {Store} from '../models';
import {StorePincodeCoverageRepository, StoreRepository} from '../repositories';
import {hasRealCoordinates} from './geocoding.service';

const EARTH_RADIUS_KM = 6371;
const DEFAULT_RADIUS_KM = 15;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance between two lat/lng points, in km. */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
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
 * Radius is configurable via STORE_ASSIGNMENT_RADIUS_KM so it can be
 * tuned without a code change; defaults to 15km when unset or invalid.
 */
@injectable({scope: BindingScope.TRANSIENT})
export class StoreAssignmentService {
  constructor(
    @repository(StoreRepository) private storeRepo: StoreRepository,
    @repository(StorePincodeCoverageRepository)
    private coverageRepo: StorePincodeCoverageRepository,
  ) {}

  static radiusKm(): number {
    const raw = Number(process.env.STORE_ASSIGNMENT_RADIUS_KM);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RADIUS_KM;
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
   * One-call "which store serves this location" — coordinates first
   * (nearest active store within the radius), then the pincode coverage
   * table as a fallback. Same precedence as the customer app's pickup
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

    if (input.pincode) {
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

  /** Nearest active store explicitly covering a pincode. */
  async resolveForPincode(pincode: string): Promise<Store | null> {
    const normalized = String(pincode ?? '').trim();
    if (!/^\d{6}$/.test(normalized)) return null;

    const coverage = await this.coverageRepo.find({
      where: {pincode: normalized, isActive: true, isDeleted: false} as object,
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
}
