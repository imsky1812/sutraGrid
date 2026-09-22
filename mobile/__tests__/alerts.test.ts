import { appliesTo, isLive, CATEGORY_GLYPH } from '../src/alerts';

const alert = (over = {}) =>
  ({
    id: 1,
    vehicle_id: null,
    category: 'CONGESTION',
    severity: 'INFO',
    message: 'Congestion ahead',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    ...over,
  }) as any;

describe('appliesTo', () => {
  it('accepts a broadcast', () => {
    expect(appliesTo(alert({ vehicle_id: null }), 'veh-1')).toBe(true);
  });

  it('accepts an alert addressed to this vehicle', () => {
    expect(appliesTo(alert({ vehicle_id: 'veh-1' }), 'veh-1')).toBe(true);
  });

  // A driver may own several vehicles; an alert for one is not for another.
  it('rejects an alert addressed to a different vehicle', () => {
    expect(appliesTo(alert({ vehicle_id: 'veh-2' }), 'veh-1')).toBe(false);
  });
});

describe('isLive', () => {
  it('accepts an alert that has not expired', () => {
    expect(isLive(alert())).toBe(true);
  });

  it('rejects an expired alert', () => {
    expect(isLive(alert({ expires_at: new Date(Date.now() - 1000).toISOString() }))).toBe(false);
  });

  it('treats the expiry instant as past', () => {
    const now = Date.now();
    expect(isLive(alert({ expires_at: new Date(now).toISOString() }), now)).toBe(false);
  });
});

describe('CATEGORY_GLYPH', () => {
  it('covers every category the database allows', () => {
    expect(Object.keys(CATEGORY_GLYPH).sort()).toEqual(
      ['CONGESTION', 'EMERGENCY', 'HAZARD', 'MESSAGE', 'RULE'],
    );
  });
});
