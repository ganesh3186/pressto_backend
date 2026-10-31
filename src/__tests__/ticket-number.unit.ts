import {expect} from '@loopback/testlab';
import {ticketNumberPeriod} from '../utils/ticket-number';

describe('monthly ticket numbering', () => {
  it('changes month at midnight in India', () => {
    expect(ticketNumberPeriod(new Date('2026-10-31T18:29:59Z'))).to.eql({
      period: 202610, monthYear: '1026',
    });
    expect(ticketNumberPeriod(new Date('2026-10-31T18:30:00Z'))).to.eql({
      period: 202611, monthYear: '1126',
    });
  });

  it('uses a separate period for January and for the same month next year', () => {
    expect(ticketNumberPeriod(new Date('2026-12-31T18:30:00Z'))).to.eql({
      period: 202701, monthYear: '0127',
    });
    expect(ticketNumberPeriod(new Date('2027-11-01T00:00:00Z'))).to.eql({
      period: 202711, monthYear: '1127',
    });
  });
});
