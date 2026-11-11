import {expect} from '@loopback/testlab';
import {securityId, UserProfile} from '@loopback/security';
import {RiderStoreController} from '../controllers/rider-store.controller';
import {RiderTransferController} from '../controllers/rider-transfer.controller';
import {GeocodingService, PincodeLookupResult} from '../services/geocoding.service';
import {rankStoresWithinRadius, StoreLocationService} from '../services/store-location.service';

type Row = Record<string, unknown>;
const user = {[securityId]: 'user-1'} as UserProfile;

/** A stub of the shared lookup: PIN code → result, counting calls. */
function geocoder(results: Record<string, PincodeLookupResult>) {
  const calls: string[] = [];
  return {
    calls,
    service: {
      geocodePincode: async (pin: string) => {
        calls.push(pin);
        return results[pin] ?? {status: 'not_found'};
      },
    } as unknown as GeocodingService,
  };
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as {statusCode: number; code?: string};
  }
  throw new Error('Expected the request to be rejected.');
}

describe('StoreLocationService.resolveCoordinates (coordinate fallback)', () => {
  it('uses valid store coordinates, else the PIN code, else nulls — per store', async () => {
    const {service, calls} = geocoder({
      '400001': {status: 'found', latitude: 18.94, longitude: 72.83},
      '400002': {status: 'unavailable'},
    });
    const locations = new StoreLocationService({} as never, service);

    const result = await locations.resolveCoordinates([
      {pincode: '400050', latitude: '19.05', longitude: '72.83'},
      {pincode: '400001', latitude: null, longitude: 72.8},
      {pincode: ' 400001 ', latitude: 0, longitude: 0},
      {pincode: '400001', latitude: 'abc', longitude: 72.8},
      {pincode: '400002', latitude: null, longitude: null},
      {pincode: '400003'},
      {pincode: null},
    ]);

    expect(result).to.deepEqual([
      {pincode: '400050', latitude: 19.05, longitude: 72.83, coordinateSource: 'store'},
      {pincode: '400001', latitude: 18.94, longitude: 72.83, coordinateSource: 'pincode'},
      {pincode: '400001', latitude: 18.94, longitude: 72.83, coordinateSource: 'pincode'},
      {pincode: '400001', latitude: 18.94, longitude: 72.83, coordinateSource: 'pincode'},
      {pincode: '400002', latitude: null, longitude: null, coordinateSource: null},
      {pincode: '400003', latitude: null, longitude: null, coordinateSource: null},
      {pincode: null, latitude: null, longitude: null, coordinateSource: null},
    ]);
    // One lookup per distinct PIN code; stores with their own coordinates never look up.
    expect(calls.sort()).to.deepEqual(['400001', '400002', '400003']);
  });

  it('looks up at most five PIN codes at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    const locations = new StoreLocationService({} as never, {
      geocodePincode: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise(resolve => setTimeout(resolve, 5));
        inFlight--;
        return {status: 'found', latitude: 19, longitude: 72.8};
      },
    } as unknown as GeocodingService);
    const stores = Array.from({length: 12}, (_, i) => ({pincode: String(400001 + i)}));

    const result = await locations.resolveCoordinates(stores);

    expect(result.every(r => r.coordinateSource === 'pincode')).to.be.true();
    expect(peak).to.equal(5);
  });

  it('never throws when the lookup itself fails', async () => {
    const locations = new StoreLocationService({} as never, {
      geocodePincode: async () => { throw new Error('boom'); },
    } as unknown as GeocodingService);
    expect(await locations.resolveCoordinates([{pincode: '400001'}])).to.deepEqual([
      {pincode: '400001', latitude: null, longitude: null, coordinateSource: null},
    ]);
  });
});

describe('GeocodingService.geocodePincode', () => {
  const realKey = process.env.GOOGLE_GEOCODING_API_KEY;
  beforeEach(() => { process.env.GOOGLE_GEOCODING_API_KEY = 'test-key'; });
  afterEach(() => {
    if (realKey === undefined) delete process.env.GOOGLE_GEOCODING_API_KEY;
    else process.env.GOOGLE_GEOCODING_API_KEY = realKey;
  });

  function withResponses(...responses: Array<Row | Error>) {
    const service = new GeocodingService();
    const urls: string[] = [];
    let time = 1_000_000;
    const clock = {advance: (ms: number) => { time += ms; }};
    Object.assign(service, {
      now: () => time,
      fetchJson: async (url: string) => {
        urls.push(url);
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    });
    return {service, urls, clock};
  }
  const postalCode = (lat: number, lng: number) => ({
    status: 'OK',
    results: [{types: ['postal_code'], geometry: {location: {lat, lng}}}],
  });

  it('resolves a PIN code and caches the success', async () => {
    const {service, urls} = withResponses(postalCode(18.94, 72.83));
    expect(await service.geocodePincode('400001')).to.deepEqual({status: 'found', latitude: 18.94, longitude: 72.83});
    expect(await service.geocodePincode('400001')).to.deepEqual({status: 'found', latitude: 18.94, longitude: 72.83});
    expect(urls).to.have.length(1);
    expect(decodeURIComponent(urls[0])).to.containEql('components=postal_code:400001|country:IN');
  });

  it('maps ZERO_RESULTS and non-postal matches to not_found', async () => {
    const {service} = withResponses(
      {status: 'ZERO_RESULTS', results: []},
      {status: 'OK', results: [{types: ['country'], geometry: {location: {lat: 20.6, lng: 79}}}]},
    );
    expect(await service.geocodePincode('999999')).to.deepEqual({status: 'not_found'});
    expect(await service.geocodePincode('999998')).to.deepEqual({status: 'not_found'});
  });

  it('remembers an outage for a minute and an unknown PIN code for a day, then asks again', async () => {
    const {service, urls, clock} = withResponses(
      {status: 'OVER_QUERY_LIMIT'},
      new Error('socket hang up'),
      postalCode(18.94, 72.83),
      {status: 'ZERO_RESULTS', results: []},
    );
    expect(await service.geocodePincode('400001')).to.deepEqual({status: 'unavailable'});
    expect(await service.geocodePincode('400001')).to.deepEqual({status: 'unavailable'});
    expect(urls).to.have.length(1);
    clock.advance(61_000);
    expect(await service.geocodePincode('400001')).to.deepEqual({status: 'unavailable'});
    expect(urls).to.have.length(2);
    clock.advance(61_000);
    expect(await service.geocodePincode('400001')).to.containDeep({status: 'found'});
    expect(urls).to.have.length(3);

    expect(await service.geocodePincode('999999')).to.deepEqual({status: 'not_found'});
    clock.advance(60 * 60 * 1000);
    expect(await service.geocodePincode('999999')).to.deepEqual({status: 'not_found'});
    expect(urls).to.have.length(4);

    delete process.env.GOOGLE_GEOCODING_API_KEY;
    expect(await new GeocodingService().geocodePincode('400001')).to.deepEqual({status: 'unavailable'});
  });
});

describe('rankStoresWithinRadius', () => {
  const origin = {latitude: 0, longitude: 0};
  const located = (id: string, km: number, name = id) => ({
    id, name, pincode: '400001', latitude: km, longitude: 0, coordinateSource: 'store' as const,
  });
  // Distance stub: the store's latitude *is* its distance, so edges are exact.
  const byLatitude = (_: unknown, b: {latitude: number}) => b.latitude;

  it('includes a store exactly at the radius, excludes one just outside, filters before rounding', () => {
    const result = rankStoresWithinRadius(
      origin,
      [located('outside', 15.004), located('edge', 15), located('near', 2.345678), located('just-out', 15.0000001)],
      15,
      byLatitude,
    );
    expect(result.map(s => s.id)).to.deepEqual(['near', 'edge']);
    expect(result[0].distanceKm).to.equal(2.35);
    expect(result[1].distanceKm).to.equal(15);
  });

  it('sorts nearest first and skips stores without coordinates', () => {
    const result = rankStoresWithinRadius(
      origin,
      [located('c', 9), located('a', 1), {...located('none', 1), latitude: null, longitude: null, coordinateSource: null}],
      15,
      byLatitude,
    );
    expect(result.map(s => s.id)).to.deepEqual(['a', 'c']);
  });
});

describe('GET /rider/stores/nearby', () => {
  // ~12 km due north of the 400001 centroid used below.
  const ORIGIN = {latitude: 18.94, longitude: 72.83};
  const kmNorth = (km: number) => ORIGIN.latitude + (km / 6371) * (180 / Math.PI);
  const realRadius = process.env.STORE_SEARCH_RADIUS_KM;
  afterEach(() => {
    if (realRadius === undefined) delete process.env.STORE_SEARCH_RADIUS_KM;
    else process.env.STORE_SEARCH_RADIUS_KM = realRadius;
  });

  function controllerWith(stores: Row[], lookups: Record<string, PincodeLookupResult>) {
    let storeWhere: unknown;
    const {service} = geocoder({'400001': {status: 'found', ...ORIGIN}, ...lookups});
    const storeRepo = {
      find: async (filter: {where: Row}) => {
        storeWhere = filter.where;
        // Mirror the DB filter so an inactive/deleted store can't sneak through.
        return stores.filter(s => s.isActive !== false && s.isDeleted !== true);
      },
    };
    const controller = new RiderStoreController(
      {findOne: async () => ({id: 'rider-1', isActive: true})} as never,
      service,
      new StoreLocationService(storeRepo as never, service),
    );
    return {controller, storeWhere: () => storeWhere};
  }

  it('returns nearby active stores from any PIN code, with fallback coordinates, nearest first', async () => {
    delete process.env.STORE_SEARCH_RADIUS_KM;
    const {controller, storeWhere} = controllerWith(
      [
        {id: 's12', name: 'Twelve', pincode: '400012', latitude: kmNorth(12), longitude: ORIGIN.longitude},
        {id: 's3', name: 'Three', pincode: '400003', latitude: null, longitude: null},
        {id: 'far', name: 'Far', pincode: '410001', latitude: kmNorth(40), longitude: ORIGIN.longitude},
        {id: 'unknown', name: 'Unknown', pincode: '400099', latitude: null, longitude: null},
        {id: 'closed', name: 'Closed', pincode: '400001', latitude: ORIGIN.latitude, longitude: ORIGIN.longitude, isActive: false},
      ],
      {'400003': {status: 'found', latitude: kmNorth(3), longitude: ORIGIN.longitude}},
    );

    const result = await controller.nearbyStores(user, ' 400001 ');

    expect(storeWhere()).to.deepEqual({isActive: true, isDeleted: false});
    expect(result.pincode).to.equal('400001');
    expect(result.radiusKm).to.equal(15);
    expect(result.stores.map(s => [s.id, s.coordinateSource, s.distanceKm])).to.deepEqual([
      ['s3', 'pincode', 3],
      ['s12', 'store', 12],
    ]);
    expect(Object.keys(result.stores[0]).sort()).to.deepEqual(
      ['coordinateSource', 'distanceKm', 'id', 'latitude', 'longitude', 'name', 'pincode'],
    );
  });

  it('drops the 12 km store when STORE_SEARCH_RADIUS_KM is 10', async () => {
    process.env.STORE_SEARCH_RADIUS_KM = '10';
    const {controller} = controllerWith(
      [{id: 's12', name: 'Twelve', pincode: '400012', latitude: kmNorth(12), longitude: ORIGIN.longitude}],
      {},
    );
    expect(await controller.nearbyStores(user, '400001')).to.deepEqual({pincode: '400001', radiusKm: 10, stores: []});
  });

  it('returns 200 with an empty list when no store qualifies', async () => {
    const {controller} = controllerWith([], {});
    expect(await controller.nearbyStores(user, '400001')).to.deepEqual({pincode: '400001', radiusKm: 15, stores: []});
  });

  it('returns 400 for invalid input, 422 for an unknown PIN code, 503 when the lookup is down', async () => {
    const {controller} = controllerWith([], {'400002': {status: 'unavailable'}});
    for (const bad of [undefined, '', '40001', '4000011', '012345', 'abcdef', '400 01']) {
      const error = await rejection(controller.nearbyStores(user, bad));
      expect(error.statusCode).to.equal(400);
      expect(error.code).to.equal('INVALID_PINCODE');
    }
    const notFound = await rejection(controller.nearbyStores(user, '999999'));
    expect(notFound.statusCode).to.equal(422);
    expect(notFound.code).to.equal('PINCODE_NOT_FOUND');
    const down = await rejection(controller.nearbyStores(user, '400002'));
    expect(down.statusCode).to.equal(503);
    expect(down.code).to.equal('PINCODE_LOOKUP_UNAVAILABLE');
  });
});

describe('GET /rider/transfers store coordinates', () => {
  it('returns pincode, coordinates and source for both stores, resolving each independently', async () => {
    const {service} = geocoder({
      '400002': {status: 'found', latitude: 18.95, longitude: 72.84},
      '400003': {status: 'unavailable'},
    });
    const stores: Row[] = [
      {id: 'from-1', name: 'Origin', pincode: '400001', latitude: '19.01', longitude: '72.81'},
      {id: 'to-1', name: 'Fallback', pincode: '400002', latitude: null, longitude: '72.8'},
      {id: 'to-2', name: 'Unlocatable', pincode: '400003', latitude: null, longitude: null},
    ];
    const controller = Object.assign(Object.create(RiderTransferController.prototype), {
      resolveActiveRider: async () => ({id: 'rider-1', isActive: true}),
      transferRepository: {
        find: async () => [
          {id: 't1', bagId: 'b1', fromStoreId: 'from-1', toStoreId: 'to-1'},
          {id: 't2', bagId: 'b2', fromStoreId: 'from-1', toStoreId: 'to-2'},
          {id: 't3', bagId: 'b3', fromStoreId: 'from-1', toStoreId: 'gone'},
        ],
      },
      transferItemRepository: {find: async () => []},
      bagRepository: {find: async () => [{id: 'b1', bagNumber: 7}]},
      storeRepository: {find: async () => stores},
      storeLocationService: new StoreLocationService({} as never, service),
    }) as RiderTransferController;

    const {transfers} = (await controller.myTransfers(user)) as {transfers: Row[]};

    expect(transfers).to.have.length(3);
    expect(transfers[0].fromStore).to.deepEqual({
      id: 'from-1', name: 'Origin', pincode: '400001', latitude: 19.01, longitude: 72.81, coordinateSource: 'store',
    });
    expect(transfers[0].toStore).to.deepEqual({
      id: 'to-1', name: 'Fallback', pincode: '400002', latitude: 18.95, longitude: 72.84, coordinateSource: 'pincode',
    });
    expect(transfers[1].toStore).to.deepEqual({
      id: 'to-2', name: 'Unlocatable', pincode: '400003', latitude: null, longitude: null, coordinateSource: null,
    });
    expect(transfers[1].fromStore).to.containDeep({coordinateSource: 'store'});
    expect(transfers[2].toStore).to.deepEqual({
      id: 'gone', name: null, pincode: null, latitude: null, longitude: null, coordinateSource: null,
    });
  });
});
