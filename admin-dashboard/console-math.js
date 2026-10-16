// Small pure helpers for the console, kept apart so they can be tested without
// a browser. The console imports them; supabase/tests/console_math.test.mjs
// tests them.

/**
 * When something last happened, at the precision an operator needs: seconds
 * while it is fresh, a time of day later on, and a date once it is not today.
 * "14:02" alone was ambiguous for a vehicle last seen three days ago.
 */
export function formatSeen(value, now = Date.now()) {
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;

  const d = new Date(t);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date(now).toDateString()) return `${Math.floor(s / 3600)} h ago`;
  if (d.toDateString() === new Date(now - 86_400_000).toDateString()) return `yesterday ${time}`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

const overlaps = (a, b) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Which map labels to show when they would overlap. Labels are taken in
 * priority order (most important first) and each is kept only if it clears
 * every label already kept. Returns the ids of the labels to hide.
 *
 * @param {{ id: string, priority: number, left: number, top: number, right: number, bottom: number }[]} labels
 * @param {number} gap  Breathing room, in pixels, required between two labels.
 */
export function labelsToHide(labels, gap = 4) {
  const kept = [];
  const hidden = new Set();
  [...labels]
    .sort((a, b) => b.priority - a.priority)
    .forEach((label) => {
      const padded = {
        left: label.left - gap,
        top: label.top - gap,
        right: label.right + gap,
        bottom: label.bottom + gap,
      };
      if (kept.some((k) => overlaps(padded, k))) hidden.add(label.id);
      else kept.push(label);
    });
  return hidden;
}

/**
 * What an operator is told about an alert they sent.
 *
 * A receipt is written when the alert reaches an open app. One delivered to a
 * closed app by push leaves none, so a missing receipt is "not yet seen in
 * the app" - never "failed".
 *
 * @param {{ vehicle_id: string | null }} alert
 * @param {Map<string, string>} receipts  vehicle id -> when it arrived
 * @param {{ liveCount: number, targetOffline: boolean }} fleet
 * @returns {{ tone: 'ok' | 'wait' | 'off', text: string }}
 */
export function deliveryStatus(alert, receipts, { liveCount = 0, targetOffline = false } = {}) {
  if (alert.vehicle_id) {
    const at = receipts.get(alert.vehicle_id);
    if (at) return { tone: 'ok', text: `Received in the app ${formatSeen(at)}` };
    return targetOffline
      ? { tone: 'off', text: 'Vehicle offline · sent by push, shown in the app when it next opens' }
      : { tone: 'wait', text: 'Sent · waiting for the app' };
  }
  const n = receipts.size;
  if (n === 0) return { tone: 'wait', text: `Sent to the fleet · ${liveCount} live, none confirmed yet` };
  return {
    tone: 'ok',
    text: `Received in ${n} app${n === 1 ? '' : 's'}${liveCount ? ` · ${liveCount} live now` : ''}`,
  };
}
