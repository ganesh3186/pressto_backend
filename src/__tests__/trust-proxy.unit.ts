import {expect} from '@loopback/testlab';
import {trustProxySetting} from '../index';

describe('trust proxy setting', () => {
  it('trusts only a loopback proxy when TRUST_PROXY is unset', () => {
    expect(trustProxySetting(undefined)).to.equal('loopback');
    expect(trustProxySetting('')).to.equal('loopback');
  });

  it('reads a hop count for a load balancer in front of the API', () => {
    expect(trustProxySetting('1')).to.equal(1);
  });

  it('reads booleans and passes subnet lists through unchanged', () => {
    expect(trustProxySetting('true')).to.equal(true);
    expect(trustProxySetting('false')).to.equal(false);
    expect(trustProxySetting('loopback, 10.0.0.0/16')).to.equal('loopback, 10.0.0.0/16');
  });
});
