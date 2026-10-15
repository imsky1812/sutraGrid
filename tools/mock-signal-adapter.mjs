#!/usr/bin/env node
/**
 * A reference implementation of the CITY side of docs/signal-adapter.md.
 *
 * This is what a traffic-signal vendor or a city's ATCS team would build into
 * their controller: an HTTPS endpoint that receives SUTRA's requests, checks
 * they really came from SUTRA, and answers yes or no. It changes no lights; it
 * logs what it is asked and how it would answer, so the contract can be
 * exercised end to end without a real junction.
 *
 *   SIGNAL_ADAPTER_SECRET=shared-secret node tools/mock-signal-adapter.mjs
 *   # listens on http://localhost:8787
 *
 * Point SUTRA at it with the signal-dispatch function's SIGNAL_ADAPTER_URL.
 * Set REJECT_OSM_IDS=123,456 to see how a refusal is handled.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

/** Requests older than this are refused, so a captured one cannot be replayed. */
const MAX_AGE_S = 300;

export function verify(secret, timestamp, body, header) {
  if (!secret || !timestamp || !header?.startsWith('v1=')) return false;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > MAX_AGE_S) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const given = header.slice(3);
  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/**
 * What a controller decides. A real one would check the junction's own state:
 * manual control, a fault, a conflicting pre-emption already running.
 */
export function decide(command, { reject = new Set() } = {}) {
  const valid = ['PREEMPT', 'HOLD_GREEN', 'RELEASE'];
  if (command?.version !== 1 || !valid.includes(command.command) || !command.junction?.osm_id) {
    return { status: 'REJECTED', reason: 'Malformed command.' };
  }
  // A release is always accepted: returning a junction to normal is safe.
  if (command.command !== 'RELEASE' && reject.has(String(command.junction.osm_id))) {
    return { status: 'REJECTED', reason: 'Junction is under manual control.' };
  }
  return { status: 'ACKNOWLEDGED', controller_ref: `mock-${command.command_id}` };
}

export function createAdapter({ secret, reject = new Set(), log = console.log } = {}) {
  return createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const reply = (code, payload) => {
        res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
      };

      if (!verify(secret, req.headers['x-sutra-timestamp'], body, req.headers['x-sutra-signature'])) {
        log('refused: bad or missing signature');
        return reply(401, { status: 'REJECTED', reason: 'Signature did not verify.' });
      }

      let command;
      try {
        command = JSON.parse(body);
      } catch {
        return reply(400, { status: 'REJECTED', reason: 'Body is not JSON.' });
      }

      const answer = decide(command, { reject });
      log(
        `${command.command} junction ${command.junction?.osm_id}` +
          (command.eta_seconds != null ? ` eta ${command.eta_seconds}s` : '') +
          ` -> ${answer.status}${answer.reason ? ` (${answer.reason})` : ''}`,
      );
      reply(200, answer);
    });
  });
}

// Run directly: start a server.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const secret = process.env.SIGNAL_ADAPTER_SECRET;
  if (!secret) {
    console.error('Set SIGNAL_ADAPTER_SECRET to the secret shared with SUTRA.');
    process.exit(1);
  }
  const reject = new Set((process.env.REJECT_OSM_IDS ?? '').split(',').filter(Boolean));
  const port = Number(process.env.PORT ?? 8787);
  createAdapter({ secret, reject }).listen(port, () => {
    console.log(`Mock signal adapter on http://localhost:${port} - logs requests, changes no lights.`);
  });
}
