// The console's small pure helpers: dated "last seen", label collision, and
// how alert delivery is worded.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { deliveryStatus, formatSeen, labelsToHide } from '../../admin-dashboard/console-math.js';

const NOW = new Date(2026, 9, 16, 15, 0, 0).getTime();

describe('formatSeen', () => {
  test('fresh things in seconds and minutes', () => {
    assert.equal(formatSeen(NOW - 3_000, NOW), 'just now');
    assert.equal(formatSeen(NOW - 42_000, NOW), '42s ago');
    assert.equal(formatSeen(NOW - 12 * 60_000, NOW), '12 min ago');
  });

  test('earlier today in hours', () => {
    assert.equal(formatSeen(NOW - 3 * 3_600_000, NOW), '3 h ago');
  });

  // The bug: a bare "14:02" for a vehicle last seen days ago.
  test('anything older carries its day', () => {
    const yesterday = formatSeen(new Date(2026, 9, 15, 14, 2), NOW);
    assert.match(yesterday, /^yesterday /);
    const older = formatSeen(new Date(2026, 9, 12, 14, 2), NOW);
    assert.match(older, /12/);
    assert.doesNotMatch(older, /ago/);
  });

  test('nonsense in, a dash out', () => {
    assert.equal(formatSeen('not a date', NOW), '—');
  });
});

describe('labelsToHide', () => {
  const box = (id, priority, left, top, w = 100, h = 20) => ({
    id, priority, left, top, right: left + w, bottom: top + h,
  });

  test('labels apart are all shown', () => {
    assert.equal(labelsToHide([box('a', 1, 0, 0), box('b', 1, 300, 0)]).size, 0);
  });

  test('of two overlapping, the more important one stays', () => {
    const hidden = labelsToHide([box('stale', 1, 0, 0), box('selected', 9, 30, 5)]);
    assert.deepEqual([...hidden], ['stale']);
  });

  test('a hidden label does not block a third', () => {
    // b hides behind a; c overlaps only b, so c stays.
    const hidden = labelsToHide([box('a', 3, 0, 0), box('b', 2, 60, 0), box('c', 1, 130, 0)]);
    assert.deepEqual([...hidden], ['b']);
  });
});

describe('deliveryStatus', () => {
  const received = new Map([['veh-1', new Date(NOW - 5_000).toISOString()]]);

  test('a targeted alert that reached the app', () => {
    const s = deliveryStatus({ vehicle_id: 'veh-1' }, received);
    assert.equal(s.tone, 'ok');
    assert.match(s.text, /^Received in the app/);
  });

  test('to an offline vehicle, says so, and never "failed"', () => {
    const s = deliveryStatus({ vehicle_id: 'veh-2' }, new Map(), { targetOffline: true });
    assert.equal(s.tone, 'off');
    assert.match(s.text, /offline/);
    assert.doesNotMatch(s.text, /fail/i);
  });

  test('a broadcast counts the apps that confirmed', () => {
    const two = new Map([['a', 'x'], ['b', 'y']]);
    assert.match(deliveryStatus({ vehicle_id: null }, two, { liveCount: 3 }).text, /Received in 2 apps · 3 live/);
    assert.equal(deliveryStatus({ vehicle_id: null }, new Map(), { liveCount: 3 }).tone, 'wait');
  });
});
