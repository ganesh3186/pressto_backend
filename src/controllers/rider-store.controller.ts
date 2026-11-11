import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {get, HttpErrors, param, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {RiderRepository} from '../repositories';
import {GeocodingService, INDIAN_PINCODE_PATTERN} from '../services/geocoding.service';
import {NearbyStoreResult, StoreLocationService} from '../services/store-location.service';

/**
 * Rider-facing store search by distance. Riders are not store-bound (see
 * GET /rider/stores, which lists every active store), so every active,
 * non-deleted store is a candidate — including stores in other PIN codes.
 */
export class RiderStoreController {
  constructor(
    @repository(RiderRepository) private riderRepository: RiderRepository,
    @inject('services.geocoding') private geocodingService: GeocodingService,
    @inject('services.store-location') private storeLocationService: StoreLocationService,
  ) {}

  private async resolveActiveRider(currentUser: UserProfile) {
    const rider = await this.riderRepository.findOne({
      where: {userId: currentUser[securityId], isDeleted: false},
    });
    if (!rider) throw new HttpErrors.Forbidden('This account is not registered as a rider.');
    if (!rider.isActive) throw new HttpErrors.Forbidden('This rider account is inactive.');
    return rider;
  }

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @get('/rider/stores/nearby')
  @response(200, {
    description:
      'Active stores within STORE_SEARCH_RADIUS_KM (straight-line) of a PIN code, nearest first. ' +
      '400: invalid PIN code. 422: PIN code not found. 503: PIN code lookup temporarily unavailable.',
  })
  async nearbyStores(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('pincode', {description: 'Six-digit Indian PIN code, e.g. 400001.'})
    pincodeParam?: string,
  ): Promise<{pincode: string; radiusKm: number; stores: NearbyStoreResult[]}> {
    await this.resolveActiveRider(currentUser);

    const pincode = String(pincodeParam ?? '').trim();
    if (!INDIAN_PINCODE_PATTERN.test(pincode)) {
      throw Object.assign(
        new HttpErrors.BadRequest('pincode must be a six-digit Indian PIN code, e.g. 400001.'),
        {code: 'INVALID_PINCODE'},
      );
    }

    const origin = await this.geocodingService.geocodePincode(pincode);
    if (origin.status === 'not_found') {
      throw Object.assign(new HttpErrors.UnprocessableEntity(`PIN code ${pincode} could not be found.`), {
        code: 'PINCODE_NOT_FOUND',
      });
    }
    if (origin.status === 'unavailable') {
      // expose: 5xx messages are otherwise replaced with the generic status text.
      throw Object.assign(
        new HttpErrors.ServiceUnavailable('PIN code lookup is temporarily unavailable. Please try again.'),
        {code: 'PINCODE_LOOKUP_UNAVAILABLE', expose: true},
      );
    }

    const {radiusKm, stores} = await this.storeLocationService.findNearby({
      latitude: origin.latitude,
      longitude: origin.longitude,
    });
    return {pincode, radiusKm, stores};
  }
}
