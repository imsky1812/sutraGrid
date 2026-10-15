// Push one alert to the phones it is meant for.
//
// Called by the database (through pg_net) whenever an alert is inserted. It
// takes only an alert id and trusts nothing else in the request: the alert, its
// text and its recipients all come from claim_alert_push, which also marks the
// alert as handled so a repeated call sends nothing. That is what makes it safe
// for this function to be reachable with the public anon key.
//
// Like the other functions, this file has no Deno globals so it can be unit
// tested under Node; index.ts is the wiring.

export type Deps = {
  supabaseUrl: string;
  /** The service-role key: claim_alert_push is closed to everyone else. */
  serviceKey: string;
  pushUrl: string;
  fetchImpl: typeof fetch;
  /** Injected so tests do not wait out a real back-off. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export const DEFAULT_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/** Must match the channel the app creates, or Android shows nothing at all. */
export const ALERT_CHANNEL = 'sutra-alerts-v1';
export const ALERT_SOUND = 'alert_beep.wav';

/** Expo's limit per request. */
export const BATCH = 100;

/**
 * Never let a message sit in a queue longer than this. A delayed give-way
 * warning is not merely useless but wrong - the ambulance has gone.
 */
const MIN_TTL_S = 30;

type Category = 'CONGESTION' | 'RULE' | 'HAZARD' | 'MESSAGE' | 'EMERGENCY';

/** Matches the app's own notifications, so a pushed alert reads the same. */
export const CATEGORY_TITLE: Record<Category, string> = {
  CONGESTION: 'Congestion ahead',
  RULE: 'Rule warning',
  HAZARD: 'Hazard ahead',
  MESSAGE: 'Message from control',
  EMERGENCY: 'Emergency vehicle approaching',
};

export const CATEGORY_GLYPH: Record<Category, string> = {
  CONGESTION: '🚧',
  RULE: '⚠️',
  HAZARD: '⛔',
  MESSAGE: '💬',
  EMERGENCY: '🚑',
};

export type Claimed = {
  alert_id: number;
  category: Category;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  message: string;
  expires_at: string;
  tokens: string[];
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * The tag the app also uses for its own notification of this alert. Android
 * replaces a shown notification that has the same tag, which is how a phone
 * that is open and also receives the push ends up with one notification.
 */
export function tagFor(alertId: number): string {
  return `sutra-alert-${alertId}`;
}

export function titleFor(alert: Pick<Claimed, 'category' | 'severity' | 'message'>): string {
  const title = /^overspeeding/i.test(alert.message)
    ? 'Overspeeding'
    : CATEGORY_TITLE[alert.category] ?? 'Alert';
  const glyph = CATEGORY_GLYPH[alert.category] ?? '';
  return `${glyph} ${alert.severity === 'CRITICAL' ? 'URGENT: ' : ''}${title}`.trim();
}

export function messagesFor(alert: Claimed, nowMs: number) {
  const ttl = Math.max(MIN_TTL_S, Math.floor((new Date(alert.expires_at).getTime() - nowMs) / 1000));
  return alert.tokens.map((to) => ({
    to,
    title: titleFor(alert),
    body: alert.message,
    // Android plays the channel's sound; this is for the day there is an iOS
    // build.
    sound: ALERT_SOUND,
    channelId: ALERT_CHANNEL,
    // Normal priority does not wake a phone in doze, and may be held for
    // minutes. Every alert here is about the road right now.
    priority: 'high' as const,
    ttl,
    tag: tagFor(alert.alert_id),
    data: { alertId: alert.alert_id, category: alert.category },
  }));
}

async function rpc<T>(deps: Deps, name: string, args: unknown): Promise<T> {
  const response = await deps.fetchImpl(`${deps.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: deps.serviceKey,
      Authorization: `Bearer ${deps.serviceKey}`,
    },
    body: JSON.stringify(args),
  });
  if (!response.ok) {
    throw new Error(`${name} failed: ${response.status} ${await response.text().catch(() => '')}`);
  }
  return (await response.json()) as T;
}

type Ticket = { status: 'ok' | 'error'; id?: string; message?: string; details?: { error?: string } };

/**
 * Send one batch, retrying once on the failures Expo documents as temporary.
 * Returns the tickets in the same order as the messages.
 */
async function sendBatch(
  deps: Deps,
  messages: ReturnType<typeof messagesFor>,
): Promise<Ticket[]> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  for (let attempt = 1; ; attempt++) {
    let response: Response | null = null;
    try {
      response = await deps.fetchImpl(deps.pushUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(messages),
      });
    } catch (e) {
      if (attempt >= 2) throw e;
    }

    if (response?.ok) {
      const body = (await response.json()) as { data?: Ticket[]; errors?: { code?: string }[] };
      if (Array.isArray(body.data)) return body.data;
      throw new Error(`Push service: ${body.errors?.map((e) => e.code).join(', ') || 'no tickets'}`);
    }

    // 429 and 5xx are worth one more try; a 400 means the payload is wrong and
    // will stay wrong.
    const retryable = !response || response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= 2) {
      throw new Error(`Push service answered ${response?.status ?? 'no response'}`);
    }
    await sleep(1000);
  }
}

export async function handler(req: Request, deps: Deps): Promise<Response> {
  let body: { alert_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  const alertId = Number(body.alert_id);
  if (!Number.isInteger(alertId) || alertId <= 0) {
    return json({ error: 'alert_id must be a positive integer.' }, 400);
  }

  let claimed: Claimed[];
  try {
    claimed = await rpc<Claimed[]>(deps, 'claim_alert_push', { p_alert_id: alertId });
  } catch (e) {
    console.error('[notify] claim failed:', (e as Error).message);
    return json({ error: 'Could not claim the alert.' }, 502);
  }

  // Already pushed, unknown, or expired with nobody to tell. All fine.
  const alert = claimed[0];
  if (!alert || alert.tokens.length === 0) {
    return json({ alertId, sent: 0 }, 200);
  }

  const messages = messagesFor(alert, (deps.now ?? Date.now)());
  let sent = 0;
  const failures = new Set<string>();
  const gone: string[] = [];

  for (let i = 0; i < messages.length; i += BATCH) {
    const batch = messages.slice(i, i + BATCH);
    let tickets: Ticket[];
    try {
      tickets = await sendBatch(deps, batch);
    } catch (e) {
      console.error('[notify] push failed for alert', alertId, (e as Error).message);
      failures.add((e as Error).message);
      continue;
    }

    tickets.forEach((ticket, k) => {
      if (ticket.status === 'ok') {
        sent += 1;
        return;
      }
      const reason = ticket.details?.error ?? ticket.message ?? 'unknown';
      failures.add(reason);
      // The app was uninstalled or notifications revoked. Expo asks senders to
      // stop, and the row is useless anyway.
      if (reason === 'DeviceNotRegistered') gone.push(batch[k].to);
    });
  }

  if (gone.length > 0) {
    try {
      await rpc(deps, 'forget_push_tokens', { p_tokens: gone });
    } catch (e) {
      console.error('[notify] could not forget devices:', (e as Error).message);
    }
  }

  if (failures.size > 0) {
    // InvalidCredentials here means the FCM key was never uploaded to EAS.
    console.error('[notify] alert', alertId, 'failures:', [...failures].join(', '));
  }

  return json(
    { alertId, sent, failed: messages.length - sent, errors: [...failures], forgotten: gone.length },
    sent > 0 || failures.size === 0 ? 200 : 502,
  );
}
