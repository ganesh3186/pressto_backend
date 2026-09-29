import {BindingScope, injectable} from '@loopback/core';
import * as https from 'https';

export interface GeocodedPoint {
  latitude: number;
  longitude: number;
}

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
  }>}> {
  /* eslint-enable @typescript-eslint/naming-convention */
    return new Promise((resolve, reject) => {
      https
        .get(url, res => {
          let data = '';
          res.on('data', chunk => (data += chunk));
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (error) {
              reject(error);
            }
          });
        })
        .on('error', reject);
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
}
