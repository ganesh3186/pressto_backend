import {BindingScope, injectable} from '@loopback/core';
import * as https from 'https';
import {ShortLivedCache} from '../utils/short-lived-cache';

export interface GeocodedPoint {
  latitude: number;
  longitude: number;
}

/**
 * Outcome of a PIN-code lookup. `not_found` is a definite "no such PIN
 * code" from the provider; `unavailable` covers everything that might
 * succeed on retry (no API key, quota, provider error, network, timeout).
 */
export type PincodeLookupResult =
  | ({status: 'found'} & GeocodedPoint)
  | {status: 'not_found'}
  | {status: 'unavailable'};

/** Six digits, not starting with 0 — the Indian PIN code format. */
export const INDIAN_PINCODE_PATTERN = /^[1-9]\d{5}$/;

/** A PIN code's centroid doesn't move, so successful lookups are kept for a day. */
const PINCODE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PINCODE_CACHE_MAX_ENTRIES = 5000;

class PincodeNotFound extends Error {}
class PincodeLookupUnavailable extends Error {}

/**
 * Whether an address/store actually has usable coordinates — null/undefined
 * obviously don't, but so doesn't the exact pair (0, 0): "Null Island", a
 * well-known placeholder in the Gulf of Guinea that shows up whenever a
 * numeric field gets defaulted/coerced instead of left empty (a manual "0"
 * typed into a form, a map that reports its click before it's finished
 * loading, etc.) — never a real customer address. Treating it as present
 * skips the geocoding fallback and lets StoreAssignmentService compute a
 * real (thousands-of-km) distance from it instead of catching the problem.
 */
export function hasRealCoordinates(
  latitude?: number | string | null,
  longitude?: number | string | null,
): boolean {
  if (latitude == null || longitude == null) return false;
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  // Outside the valid lat/long ranges is a bad input, not a location.
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
  return !(lat === 0 && lng === 0);
}

/**
 * Google Geocoding API, address text -> lat/lng. Used to fill in
 * coordinates for a customer address that has none on file (older
 * addresses, or ones saved without the frontend's location picker) so
 * StoreAssignmentService still has something to compute a distance from,
 * instead of silently giving up. Credentials are optional, same pattern
 * as NotificationService's Firebase key: the app must run normally
 * without one, this just becomes a no-op.
 */
@injectable({scope: BindingScope.SINGLETON})
export class GeocodingService {
  private warnedMissingKey = false;
  // Only successful lookups stay cached: ShortLivedCache drops a load that
  // rejects, and every non-found outcome is surfaced as a rejection below.
  private readonly pincodeCache = new ShortLivedCache<GeocodedPoint>(
    PINCODE_CACHE_TTL_MS,
    PINCODE_CACHE_MAX_ENTRIES,
  );

  private apiKey(): string | null {
    const key = process.env.GOOGLE_GEOCODING_API_KEY;
    if (key?.trim()) return key.trim();
    if (!this.warnedMissingKey) {
      this.warnedMissingKey = true;
      // eslint-disable-next-line no-console
      console.warn(
        '[GeocodingService] GOOGLE_GEOCODING_API_KEY not set — address geocoding is disabled.',
      );
    }
    return null;
  }

  // Google's own API response shape — snake_case is their API's shape, not
  // this codebase's convention (mirrors the same suppress-comment pattern
  // already used in email.service.ts/razorpay.service.ts for a third-party
  // shape).
  /* eslint-disable @typescript-eslint/naming-convention */
  private fetchJson(url: string): Promise<{status: string; results?: Array<{
    geometry: {location: {lat: number; lng: number}; location_type?: string};
    partial_match?: boolean;
    types?: string[];
  }>}> {
  /* eslint-enable @typescript-eslint/naming-convention */
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => request.destroy(new Error('Geocoding deadline exceeded')), 8000);
      const request = https
        .get(url, res => {
          let data = '';
          res.on('data', chunk => (data += chunk));
          res.on('end', () => {
            try {
              clearTimeout(timer);
              resolve(JSON.parse(data));
            } catch (error) {
              clearTimeout(timer);
              reject(error);
            }
          });
        })
        .on('error', error => {clearTimeout(timer); reject(error);});
    });
  }

  /**
   * Best-effort geocode of a free-text address. Never throws — a bad
   * response, a network error, or a missing key all just resolve to null
   * so a caller on the pickup-request path can fall back to its existing
   * NOT_SERVICEABLE handling rather than fail the whole request.
   */
  async geocodeAddress(addressText: string): Promise<GeocodedPoint | null> {
    const key = this.apiKey();
    if (!key || !addressText?.trim()) return null;

    try {
      const url =
        'https://maps.googleapis.com/maps/api/geocode/json?address=' +
        encodeURIComponent(addressText) +
        '&key=' +
        key;
      const response = await this.fetchJson(url);
      const result = response.status === 'OK' ? response.results?.[0] : undefined;
      if (!result) return null;
      return {
        latitude: result.geometry.location.lat,
        longitude: result.geometry.location.lng,
      };
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[GeocodingService] Geocoding request failed.', error);
      return null;
    }
  }

  /**
   * Shared PIN-code → coordinates lookup (the PIN code's centroid, so an
   * approximate location). Used wherever a store has no usable coordinates
   * of its own (rider transfer list, nearby-store search). Never throws.
   * Successful results are cached per process; failures are not, so a
   * provider outage or a newly-added key recovers on the next call.
   */
  async geocodePincode(pincode: string): Promise<PincodeLookupResult> {
    const pin = String(pincode ?? '').trim();
    if (!INDIAN_PINCODE_PATTERN.test(pin)) return {status: 'not_found'};
    try {
      const point = await this.pincodeCache.get(pin, () => this.loadPincode(pin));
      return {status: 'found', ...point};
    } catch (error) {
      return error instanceof PincodeNotFound ? {status: 'not_found'} : {status: 'unavailable'};
    }
  }

  private async loadPincode(pin: string): Promise<GeocodedPoint> {
    const key = this.apiKey();
    if (!key) throw new PincodeLookupUnavailable('Geocoding API key not configured.');

    let response: Awaited<ReturnType<GeocodingService['fetchJson']>>;
    try {
      const url =
        'https://maps.googleapis.com/maps/api/geocode/json?components=' +
        encodeURIComponent(`postal_code:${pin}|country:IN`) +
        '&key=' +
        key;
      response = await this.fetchJson(url);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[GeocodingService] PIN code lookup failed.', error);
      throw new PincodeLookupUnavailable('PIN code lookup failed.');
    }

    if (response.status === 'ZERO_RESULTS') throw new PincodeNotFound(pin);
    if (response.status !== 'OK') {
      // OVER_QUERY_LIMIT, REQUEST_DENIED, UNKNOWN_ERROR, … — retryable or
      // a configuration problem, never an answer about the PIN code itself.
      // eslint-disable-next-line no-console
      console.error(`[GeocodingService] PIN code lookup returned ${response.status}.`);
      throw new PincodeLookupUnavailable(response.status);
    }
    // Google can answer an unknown postal code with a broader match (the
    // whole country); only a postal_code result is an answer for this PIN.
    const result = response.results?.find(r => r.types?.includes('postal_code'));
    const lat = result?.geometry.location.lat;
    const lng = result?.geometry.location.lng;
    if (!result || !hasRealCoordinates(lat, lng)) throw new PincodeNotFound(pin);
    return {latitude: Number(lat), longitude: Number(lng)};
  }
}
