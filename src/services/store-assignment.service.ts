import {BindingScope, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {StoreRepository} from '../repositories';

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

export type NearbyStore = {id: string; name: string; code: string; distanceKm: number};

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
      .map(s => ({
        id: s.id,
        name: s.name,
        code: s.code,
        distanceKm: haversineKm(lat, lng, s.latitude as number, s.longitude as number),
      }))
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
}
