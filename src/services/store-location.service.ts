import {BindingScope, inject, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {StoreRepository} from '../repositories';
import {storeSearchRadiusKm} from '../utils/config';
import {GeocodedPoint, GeocodingService, hasRealCoordinates} from './geocoding.service';
import {haversineKm} from './store-assignment.service';

/**
 * Where a store's coordinates came from: its own saved latitude/longitude
 * (`store`), or its PIN code's centroid (`pincode` — approximate, so the
 * rider app can show it as such). null when neither is available.
 */
export type CoordinateSource = 'store' | 'pincode';

export type StoreCoordinates = {
  pincode: string | null;
  latitude: number | null;
  longitude: number | null;
  coordinateSource: CoordinateSource | null;
};

type StoreCoordinateInput = {
  pincode?: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
};

export type NearbyStoreResult = {
  id: string;
  name: string;
  pincode: string | null;
  latitude: number;
  longitude: number;
  coordinateSource: CoordinateSource;
  distanceKm: number;
};

type LocatedStore = {id: string; name: string} & StoreCoordinates;

/**
 * Keeps only stores at or below `radiusKm` from `origin`, nearest first.
 * The radius check runs on the unrounded distance — a store at 15.004 km
 * is outside a 15 km radius even though it would display as 15.00.
 */
export function rankStoresWithinRadius(
  origin: GeocodedPoint,
  stores: LocatedStore[],
  radiusKm: number,
  distanceKm: (a: GeocodedPoint, b: GeocodedPoint) => number = (a, b) =>
    haversineKm(a.latitude, a.longitude, b.latitude, b.longitude),
): NearbyStoreResult[] {
  return stores
    .filter(
      (s): s is LocatedStore & {latitude: number; longitude: number; coordinateSource: CoordinateSource} =>
        s.latitude != null && s.longitude != null && s.coordinateSource != null,
    )
    .map(s => ({store: s, distance: distanceKm(origin, {latitude: s.latitude, longitude: s.longitude})}))
    .filter(({distance}) => distance <= radiusKm)
    .sort((a, b) => a.distance - b.distance || a.store.name.localeCompare(b.store.name))
    .map(({store, distance}) => ({
      id: store.id,
      name: store.name,
      pincode: store.pincode,
      latitude: store.latitude,
      longitude: store.longitude,
      coordinateSource: store.coordinateSource,
      distanceKm: Math.round(distance * 100) / 100,
    }));
}

/**
 * The one place that decides a store's map location for rider-facing APIs:
 * the store's own coordinates when both are valid, else its PIN code's
 * centroid via the shared GeocodingService lookup (cached), else nothing.
 * Each store resolves independently, and a lookup failure never throws —
 * the caller gets nulls for that store and keeps the rest.
 */
@injectable({scope: BindingScope.TRANSIENT})
export class StoreLocationService {
  constructor(
    @repository(StoreRepository) private storeRepo: StoreRepository,
    @inject('services.geocoding') private geocodingService: GeocodingService,
  ) {}

  async resolveCoordinates(stores: StoreCoordinateInput[]): Promise<StoreCoordinates[]> {
    // One lookup per distinct PIN code, however many stores share it.
    const pending = new Map<string, Promise<GeocodedPoint | null>>();
    const lookup = (pincode: string) => {
      let result = pending.get(pincode);
      if (!result) {
        result = this.geocodingService
          .geocodePincode(pincode)
          .then(r => (r.status === 'found' ? {latitude: r.latitude, longitude: r.longitude} : null))
          .catch(() => null);
        pending.set(pincode, result);
      }
      return result;
    };

    return Promise.all(
      stores.map(async (store): Promise<StoreCoordinates> => {
        const pincode = store.pincode == null ? null : String(store.pincode).trim() || null;
        if (hasRealCoordinates(store.latitude, store.longitude)) {
          return {
            pincode,
            latitude: Number(store.latitude),
            longitude: Number(store.longitude),
            coordinateSource: 'store',
          };
        }
        const point = pincode ? await lookup(pincode) : null;
        return point
          ? {pincode, ...point, coordinateSource: 'pincode'}
          : {pincode, latitude: null, longitude: null, coordinateSource: null};
      }),
    );
  }

  /**
   * Active stores within the shared STORE_SEARCH_RADIUS_KM of `origin`,
   * nearest first — every active store is a candidate, not just those in
   * the origin's PIN code. Stores with no resolvable location are skipped.
   */
  async findNearby(origin: GeocodedPoint): Promise<{radiusKm: number; stores: NearbyStoreResult[]}> {
    const radiusKm = storeSearchRadiusKm();
    const stores = await this.storeRepo.find({
      where: {isActive: true, isDeleted: false} as object,
      fields: {id: true, name: true, pincode: true, latitude: true, longitude: true} as object,
    });
    const coordinates = await this.resolveCoordinates(stores);
    const located = stores.map((store, i) => ({id: store.id, name: store.name, ...coordinates[i]}));
    return {radiusKm, stores: rankStoresWithinRadius(origin, located, radiusKm)};
  }
}
