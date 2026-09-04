import { XMLParser } from 'fast-xml-parser';
import { ChannelNames, formatTitle, matchesFilter, FILTER_TIERS, extractRssItems, isFresh, MAX_SEEN_IDS_PER_FEED, FeedKeys, isActionablePost, isActionableCandidate, classifySignal, isSignalUndecided, classifyActionableHybrid, actionableStrategyFor, type ContentFilter, type FilterItem, type Channel, type FeedKey, type RssItem, type ItemClassification } from '@li/core';
import { sendWebPush, type PushSubscription, type VapidKeys } from './webpush';
import { CHANNEL_FEEDS } from './config';

function toFilterItem(item: RssItem): FilterItem {
  return { feedKey: item.feedKey, author: item.author, title: item.title, content: item.description };
}

export interface Env {
  TOKENS: KVNamespace;
  STATE: KVNamespace;
  WEBPUSH_QUEUE: Queue<WebPushQueueMessage>;
  VALIDATION_QUEUE: Queue<ValidationQueueMessage>;
  AI: Ai; // Workers AI binding -- embeddings for the hybrid actionable classifier (Members Forum + Stock Insights only)
  FEED_TOKEN: string;               // secret for GET /status (Authorization: Bearer)
  POLL_INTERVAL_TRADING?: string;   // minutes between polls during trading hours, default "5"
  POLL_INTERVAL_LATEDAY?: string;   // minutes between polls during late-day window, default "15"
  POLL_INTERVAL_OVERNIGHT?: string; // minutes between polls outside market hours, default "60"
  POLL_BOUNDARY_OPEN?: string;      // hhmm ET when trading hours begin, default "915"
  POLL_BOUNDARY_LATEDAY?: string;   // hhmm ET when late-day window begins, default "1400"
  POLL_BOUNDARY_CLOSE?: string;     // hhmm ET when late-day window ends, default "1615"
  MAX_PUSH_AGE_MINUTES?: string;    // content older than this won't be pushed even if newly-seen, default "120"
  MAX_ALERT_ITEMS_PER_FEED?: string; // cap on how many of a feed's most-recent posts are considered per poll, default "25"
  ACTIONABLE_AUTHORS?: string;      // comma-separated; who can trigger the 'actionable' tier, default "Sean Hyman"
  VAPID_PUBLIC_KEY: string;         // Web Push VAPID key pair — not secret, sent to browser clients as-is
  VAPID_SUBJECT: string;            // mailto: contact required by the Web Push protocol
  VAPID_PRIVATE_KEY: string;        // secret — set via: wrangler secret put VAPID_PRIVATE_KEY
  CORS_ALLOWED_ORIGIN?: string;     // origin allowed to call this API cross-origin. Unset denies every origin.
  // Per-channel dead-man's-switch pings (healthchecks.io or similar) — see issue #24.
  // One check per channel since each is an independent Cloudflare Cron Trigger registration
  // and can get stuck without the others being affected.
  HEARTBEAT_URL_MEMBERS?: string;
  HEARTBEAT_URL_STOCK?: string;
  HEARTBEAT_URL_OPTIONS?: string;
  // Populated by the [version_metadata] binding in wrangler.toml — tag is the git short SHA
  // deploy.sh passes via `wrangler deploy --tag`, surfaced through GET /status.
  CF_VERSION_METADATA: WorkerVersionMetadata;
}

// filter/authors/minLength are required on every registration. feedToken is optional here only
// for KV entries predating universal storage; recovers a stale stock/options poll token.
// kind/subscription are only ever written for a webpush registration. Undefined means Expo: every
// entry written before Web Push existed, and every entry the RN app still writes. No migration is
// needed for pre-existing entries.
interface TokenMeta {
  feedToken?: string;
  filter?: ContentFilter;
  authors?: string[];
  minLength?: number;
  kind?: 'webpush';
  subscription?: PushSubscription;
  // Epoch milliseconds of the last time this specific registration's feedToken was confirmed to
  // still have access to its channel — see ValidationQueueMessage/needsRevalidation. Set at
  // registration time (access was just verified then) and after each successful validation. A
  // real elapsed-time value, not a calendar-day string: two revalidations minutes apart
  // shouldn't both fire just because they straddle a calendar-day boundary, since each one that
  // does fire costs a real subrequest in the queue consumer.
  lastValidated?: number;
}

interface RunStats {
  lastRun: string;
  lastNotified: string | null;
  itemsFetched: number;
  numNewItems: number;
  sent: number;
  // event.scheduledTime of the last tick this channel claimed — see the duplicate-dispatch
  // guard in runChannel(). Distinct from lastRun (wall-clock): scheduledTime identifies the
  // logical cron tick and stays identical across Cloudflare's at-least-once duplicate
  // deliveries of it, whereas wall-clock time differs between them.
  lastScheduledTime?: number;
}

interface DailyStats {
  date: string;
  runs: number;
  itemsFetched: number;
  numNewItems: number;
  sent: number;
}

// Everything a channel's poll cycle reads/writes, under one KV key (`run:<channel>`). One key
// keeps this to at most 2 writes per active poll — Workers KV's free tier caps writes at
// 1,000/day account-wide, and this channel's poll cadence runs close enough to that ceiling
// for write count per invocation to matter (issue #32). `poll:<channel>` (the feed token to
// poll with) stays a separate key — it's written rarely (register/recovery), not per poll.
interface ChannelState {
  stats: RunStats;
  seen: Partial<Record<FeedKey, string[]>>;
  daily: DailyStats;
  // Epoch milliseconds of the last time this channel's TOKENS were scanned for stale
  // registrations to enqueue onto VALIDATION_QUEUE (see needsRevalidation) — undefined means
  // never scanned. Gates the scan itself, not the validation — the scan is cheap (KV list only,
  // no fetch), so imprecision here is free; the actual feedTokenHasAccess fetches happen later,
  // in bounded queue() consumer batches, never in this invocation.
  lastValidationEnqueueDate?: number;
}

function emptyDaily(date: string): DailyStats {
  return { date, runs: 0, itemsFetched: 0, numNewItems: 0, sent: 0 };
}

function emptyRunStats(): RunStats {
  return { lastRun: '', lastNotified: null, itemsFetched: 0, numNewItems: 0, sent: 0 };
}

// A registered device (and a channel's stale-registration scan) is revalidated at most this
// often.
const VALIDATION_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Pure so it's directly testable. One real elapsed-time check, reused for two different gates
// (issue #86): ChannelState.lastValidationEnqueueDate (has this channel's cheap TOKENS scan run
// in the last ~24h) and TokenMeta.lastValidated (has this specific registration's feedToken been
// confirmed valid in the last ~24h). A calendar-day string was tried first and rejected: it
// treats two events minutes apart as both "due" whenever they straddle a calendar-day boundary.
// An epoch timestamp carries strictly more information than a date string — it can always be
// converted to a calendar day when that specific reasoning is actually needed, e.g.
// DailyStats/advanceDaily's daily-bucket counters, while the reverse conversion is lossy — so
// there's no case where the string was the better choice.
export function needsRevalidation(lastValidated: number | undefined, nowMs: number): boolean {
  return lastValidated === undefined || nowMs - lastValidated >= VALIDATION_INTERVAL_MS;
}

// Pure so it's directly testable. Resets the rolling counters when `todayET` doesn't match the
// stored date, rather than requiring a separate day-boundary check at the call site.
export function advanceDaily(daily: DailyStats | undefined, todayET: string, runStats: RunStats): DailyStats {
  const base = daily && daily.date === todayET ? daily : emptyDaily(todayET);
  return {
    date: todayET,
    runs: base.runs + 1,
    itemsFetched: base.itemsFetched + runStats.itemsFetched,
    numNewItems: base.numNewItems + runStats.numNewItems,
    sent: base.sent + runStats.sent,
  };
}

// Channel-to-cron mapping: CHANNELS[i] corresponds to the cron whose minute list starts at offset i.
// wrangler.toml MUST list the three crons in this exact order, with each starting one minute later:
//   members → "0,5,10,15,..."   (offset 0)
//   stock   → "1,6,11,16,..."   (offset 1)
//   options → "2,7,12,17,..."   (offset 2)
// Changing either this array OR the wrangler.toml cron order silently breaks the channel mapping.
// ponytail: brittle by design — simplest option available; revisit if a 4th channel is added.
const CHANNELS: Channel[] = [ChannelNames.members, ChannelNames.stock, ChannelNames.options];

export function channelFromCron(cron: string): Channel {
  const offset = parseInt(cron.split(' ')[0].split(',')[0], 10);
  return CHANNELS[offset] ?? ChannelNames.members;
}

export function heartbeatUrlFor(channel: Channel, env: Env): string | undefined {
  return {
    members: env.HEARTBEAT_URL_MEMBERS,
    stock: env.HEARTBEAT_URL_STOCK,
    options: env.HEARTBEAT_URL_OPTIONS,
  }[channel];
}

// Module-level parser shared across all calls within an invocation
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

// Returns ET time components using the IANA timezone database (handles DST automatically,
// including any future rule changes by law).
// timeOfDay is minutes since midnight: e.g. 09:15 ET → 555, 14:00 ET → 840.
function getETComponents(now: Date): { day: number; timeOfDay: number; min: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? '0', 10);
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hours = get('hour');
  const min = get('minute');
  return { day: weekdays[parts.find(p => p.type === 'weekday')?.value ?? ''] ?? 0, timeOfDay: hours * 60 + min, min };
}

// Parses a wrangler.toml hhmm string (e.g. "0915") to minutes since midnight (e.g. 555).
function hhmmToMinutes(s: string): number {
  const n = parseInt(s, 10);
  return Math.floor(n / 100) * 60 + (n % 100);
}

// Returns the appropriate poll interval (minutes) for the current ET time.
// Boundary defaults (minutes since midnight ET):
//   open:    555  (09:15 ET, market open)
//   lateday: 840  (14:00 ET, reduced-activity window begins)
//   close:   975  (16:15 ET, after-hours begins)
export function getIntervalMinutes(
  now: Date,
  intervals  = { trading: 5, lateday: 15, overnight: 60 },
  boundaries = { open: 555, lateday: 840, close: 975 },
): number {
  const { day, timeOfDay } = getETComponents(now);
  if (day === 0 || day === 6) return intervals.overnight;
  if (timeOfDay >= boundaries.open    && timeOfDay < boundaries.lateday) return intervals.trading;
  if (timeOfDay >= boundaries.lateday && timeOfDay < boundaries.close)   return intervals.lateday;
  return intervals.overnight;
}

// Returns true if enough time has elapsed since lastRun for the given interval (minutes).
export function shouldPollNow(now: Date, lastRun: Date | null, interval: number): boolean {
  return (!lastRun) || (now.getTime() - lastRun.getTime() >= interval * 60_000);
}

// 'en-CA' short-date format happens to be YYYY-MM-DD, the one common English-locale option
// that's already sortable/unambiguous as a string (en-US gives M/D/YYYY, en-GB gives
// D/M/YYYY). Avoids manually assembling the string from separate {year, month, day} parts.
function getETDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
}

// Constant-time string comparison — a plain !== on secrets leaks timing information.
// Manual XOR accumulator that runs under the plain-Node runtime.
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = new TextEncoder().encode(a);
  const bufB = new TextEncoder().encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < bufA.byteLength; i++) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}

export default {
  // HTTP API (called by the app's pushService.ts, or the web-push registration page's app.js):
  //
  //   GET  /status              Authorization: Bearer <FEED_TOKEN>
  //   GET  /vapid-public-key
  //   POST /register    { token, channel, filter, authors, minLength, feed_token }
  //     or { subscription: { endpoint, keys: { p256dh, auth } }, channel, filter, authors, minLength, feed_token }
  //   POST /unregister  { token, channel } or { subscription: { endpoint }, channel }
  //   POST /test-push   { token, channel, feed_token } or { subscription, channel, feed_token }
  //     bypasses polling entirely, to confirm a registration actually receives pushes. Expo
  //     sends immediately; a webpush subscription is enqueued through the same WEBPUSH_QUEUE a
  //     real alert uses, so 'ok' there means queued, not confirmed delivered.
  //
  //   token        — Expo push token (device identifier for APNs/FCM delivery), RN app only
  //   subscription — browser PushManager subscription object, web page only. Mutually exclusive
  //                  with token; whichever is present determines the registration's delivery kind.
  //   channel      — 'members' | 'stock' | 'options'
  //   filter       — 'members' | 'actionable' | 'length' (see @li/core ContentFilter)
  //   authors      — string[], substring whitelist; [] = no author restriction (no global fallback)
  //   minLength    — number; 0 = no minimum
  //   feed_token   — WordPress auth token, required on every /register call regardless of
  //                  channel. For stock/options it also proves access — rejected with 403
  //                  if missing, invalid, or the account isn't subscribed to that channel.
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return corsPreflightResponse(request, env);
    const response = await handleRequest(request, env);
    return withCors(response, request, env);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const channel = channelFromCron(event.cron);
    // Dead-man's-switch: proves Cloudflare actually dispatched this channel's cron trigger.
    // See issue #24 — all three triggers silently stopped firing for ~15h with no error anywhere.
    const heartbeatUrl = heartbeatUrlFor(channel, env);
    if (heartbeatUrl) {
      ctx.waitUntil(fetch(heartbeatUrl).catch(() => {}));
    }
    await runChannel(channel, env, event);
  },

  // Drains WEBPUSH_QUEUE and VALIDATION_QUEUE. Cloudflare gives each consumer invocation a batch
  // from a single queue — batch.queue says which — so one export dispatches both, matching
  // Cloudflare's own documented multi-queue-single-consumer pattern rather than running two
  // separate Worker scripts for what's otherwise identical batching/ack machinery. Both known
  // queue names are matched explicitly, not one-if-else-drop-through: a batch from neither
  // (a queue renamed on one side of wrangler.toml but not the other, say) must not silently get
  // decoded as the wrong message shape.
  async queue(batch: MessageBatch<WebPushQueueMessage> | MessageBatch<ValidationQueueMessage>, env: Env): Promise<void> {
    if (batch.queue === WEBPUSH_QUEUE_NAME) {
      await drainWebPushQueue(batch as MessageBatch<WebPushQueueMessage>, env);
    } else if (batch.queue === VALIDATION_QUEUE_NAME) {
      await drainValidationQueue(batch as MessageBatch<ValidationQueueMessage>, env);
    } else {
      // Unreachable given wrangler.toml's consumer config today. Ack rather than silently drop
      // if it ever happens anyway — an un-acked message retries forever, and there's no handler
      // that would ever know what to do with it.
      batch.messages.forEach((msg) => msg.ack());
    }
  },
};

// Queue names — must match wrangler.toml's queues.consumers[].queue values exactly; that's the
// only thing batch.queue is compared against above.
const WEBPUSH_QUEUE_NAME = 'webpush-notifications';
const VALIDATION_QUEUE_NAME = 'token-validation';

// Shared by both queue handlers below rather than duplicated in each: one message's failure must
// not affect the rest of the batch, and every message is explicitly ack'd regardless of outcome
// — Cloudflare Queues auto-retries any message that isn't explicitly ack'd or retry'd, and a
// delayed re-send of stale queue content (minutes or hours later, once max_retries is exhausted)
// is worse than a missed one, the same fire-and-forget tolerance this file already applies to
// push sends generally.
async function drainQueueSafely<Body>(batch: MessageBatch<Body>, handle: (body: Body) => Promise<void>): Promise<void> {
  await Promise.all(batch.messages.map(async (msg) => {
    try {
      await handle(msg.body);
    } catch { /* one message's failure must not affect the rest of the batch */ }
    finally { msg.ack(); }
  }));
}

// Bounded per invocation by wrangler.toml's consumer max_batch_size — this is what keeps webpush
// fan-out under the 50-subrequest-per-invocation cap regardless of how many (subscriber, item)
// pairs a busy poll queues up.
async function drainWebPushQueue(batch: MessageBatch<WebPushQueueMessage>, env: Env): Promise<void> {
  const vapid: VapidKeys = { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  await drainQueueSafely(batch, async ({ channel, subscription, title, body, url }) => {
    const result = await sendWebPush(subscription, { data: { title, body, url } }, vapid);
    // gone:true (HTTP 404 or 410) is the protocol's standard "subscription no longer exists"
    // signal. Prune it now, or expired subscriptions accumulate forever.
    if (result.gone) await env.TOKENS.delete(`${channel}:web:${subscription.endpoint}`);
  });
}

// The actual feedTokenHasAccess fetch for a stale registration, decoupled from runChannel's
// notify path entirely (see the enqueue side there, and ValidationQueueMessage, issue #86) — this
// is what lets validation scale to any registered-device count without risking the 50-subrequest
// cap, bounded the same way as webpush sends by wrangler.toml's consumer max_batch_size.
async function drainValidationQueue(batch: MessageBatch<ValidationQueueMessage>, env: Env): Promise<void> {
  await drainQueueSafely(batch, async ({ channel, tokenKey, meta }) => {
    const access = meta.feedToken ? await feedTokenHasAccess(channel, meta.feedToken) : null;
    if (access === false) {
      await env.TOKENS.delete(tokenKey);
    } else if (access === true) {
      await env.TOKENS.put(tokenKey, '1', { metadata: { ...meta, lastValidated: Date.now() } satisfies TokenMeta });
    }
    // access === null: check itself failed (network blip, 5xx) — leave the registration
    // untouched; only a definitive 401/403 proves access was actually revoked. Not stamping
    // lastValidated means it's picked up again by the next day's scan.
  });
}

// The registration page is served same-origin today, via this Worker's own Static Assets. A
// browser never enforces CORS for a same-origin request, so this code is currently dormant. It
// exists for a possible future cross-origin host.
//
// Only the single origin in CORS_ALLOWED_ORIGIN is allowed to call this API. These endpoints act
// on a feed_token's behalf, so a wildcard would let any site read feed_token-scoped responses.
// The allowed origin lives in wrangler.toml as a plain config var. A wrangler.toml edit and a
// deploy are enough to change it.
//
// A browser's Origin header is always absent or a real "scheme://host" value. It is never an
// empty string. When CORS_ALLOWED_ORIGIN is unset, the fallback of '' can never match a real
// request, so every origin is denied by default.
function corsHeadersFor(request: Request, env: Pick<Env, 'CORS_ALLOWED_ORIGIN'>): Record<string, string> {
  const origin = request.headers.get('Origin');
  const allowedOrigin = env.CORS_ALLOWED_ORIGIN ?? '';
  // This response's Access-Control-Allow-Origin value depends on the request's Origin header.
  // Vary: Origin tells a cache not to serve one origin's response to another.
  return origin === allowedOrigin ? { 'Access-Control-Allow-Origin': allowedOrigin, Vary: 'Origin' } : {};
}

function corsPreflightResponse(request: Request, env: Pick<Env, 'CORS_ALLOWED_ORIGIN'>): Response {
  const headers = new Headers(corsHeadersFor(request, env));
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(null, { status: 204, headers });
}

function withCors(response: Response, request: Request, env: Pick<Env, 'CORS_ALLOWED_ORIGIN'>): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeadersFor(request, env))) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/vapid-public-key') {
    return new Response(env.VAPID_PUBLIC_KEY, { headers: { 'Content-Type': 'text/plain' } });
  }

  if (request.method === 'GET' && url.pathname === '/status') {
    const auth = request.headers.get('Authorization') ?? '';
    const secret = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!timingSafeEqualStr(secret, env.FEED_TOKEN)) {
      return new Response('unauthorized', { status: 401 });
    }
    const result: Record<string, unknown> = {
      // tag is the git short SHA deploy.sh passes via `wrangler deploy --tag` — traces this
      // exact running response back to the commit that produced it.
      version: env.CF_VERSION_METADATA,
    };
    const todayET = getETDate(new Date());
    for (const channel of CHANNELS) {
      const [tokens, runJson, pollToken] = await Promise.all([
        env.TOKENS.list<TokenMeta>({ prefix: `${channel}:` }),
        env.STATE.get(`run:${channel}`),
        env.STATE.get(`poll:${channel}`),
      ]);
      const state: ChannelState | null = runJson ? JSON.parse(runJson) : null;
      const stats = state?.stats ?? null;
      // Broken out by delivery kind because the two scale very differently: Expo sends one bulk
      // request per bucket regardless of device count, but Web Push has no bulk endpoint, so
      // registeredWebpush is the number that actually drives subrequest count per cron run.
      const registeredWebpush = tokens.keys.filter((k) => k.metadata?.kind === 'webpush').length;
      result[channel] = {
        registeredTokens: tokens.keys.length,
        registeredExpo: tokens.keys.length - registeredWebpush,
        registeredWebpush,
        seenIds:   state?.seen ? Object.values(state.seen).reduce((a, b) => a + (b?.length ?? 0), 0) : 0,
        pollToken: pollToken ? 'present' : 'missing',
        lastRun:      stats?.lastRun      ?? null,
        lastNotified: stats?.lastNotified ?? null,
        lastRunStats: stats ? {
          itemsFetched: stats.itemsFetched,
          numNewItems:  stats.numNewItems,
          sent:         stats.sent,
        } : null,
        // Only surface daily as "today's" if a poll has actually run today — an unrolled-over
        // stale date (no poll yet today) must not be mislabeled as today's stats.
        todayStats: state?.daily && state.daily.date === todayET ? state.daily : null,
      };
    }
    return new Response(JSON.stringify(result, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (request.method !== 'POST') return new Response('not found', { status: 404 });

  const body = await request.json() as {
    token?: string;
    subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    channel?: string; filter?: string; authors?: unknown; minLength?: unknown; feed_token?: string;
  };
  const channel = body.channel as Channel | null;
  if (!channel || !CHANNELS.includes(channel)) {
    return new Response('invalid channel', { status: 400 });
  }

  // token and subscription are mutually exclusive registration kinds. Only the RN app sends
  // token, and only the web page sends subscription, so token wins if somehow both are sent.
  let pushToken: string;
  let subscription: PushSubscription | undefined;
  if (typeof body.token === 'string' && body.token) {
    pushToken = body.token;
  } else if (
    body.subscription &&
    typeof body.subscription.endpoint === 'string' && body.subscription.endpoint &&
    body.subscription.keys &&
    typeof body.subscription.keys.p256dh === 'string' && body.subscription.keys.p256dh &&
    typeof body.subscription.keys.auth === 'string' && body.subscription.keys.auth
  ) {
    pushToken = body.subscription.endpoint;
    subscription = { endpoint: body.subscription.endpoint, expirationTime: null, keys: { p256dh: body.subscription.keys.p256dh, auth: body.subscription.keys.auth } };
  } else {
    return new Response('missing token or subscription', { status: 400 });
  }

  // A webpush registration's KV key is namespaced under `web:` so it can never collide with an
  // Expo push token's own key space, even though both share the same TOKENS.list() prefix scan.
  const kvKey = subscription ? `${channel}:web:${pushToken}` : `${channel}:${pushToken}`;

  if (url.pathname === '/register') {
    const filter = body.filter as ContentFilter;
    if (!FILTER_TIERS.includes(filter)) {
      return new Response('missing or invalid filter', { status: 400 });
    }
    if (!Array.isArray(body.authors) || !body.authors.every((a) => typeof a === 'string')) {
      return new Response('missing or invalid authors', { status: 400 });
    }
    if (typeof body.minLength !== 'number' || body.minLength < 0) {
      return new Response('missing or invalid minLength', { status: 400 });
    }
    const feedToken = body.feed_token;
    if (typeof feedToken !== 'string' || feedToken === '') {
      return new Response('missing or invalid feed_token', { status: 400 });
    }
    return registerDevice({ channel, pushToken, subscription, filter, authors: body.authors, minLength: body.minLength, feedToken }, env);
  }
  if (url.pathname === '/unregister') {
    await env.TOKENS.delete(kvKey);
    return new Response('ok');
  }
  if (url.pathname === '/test-push') {
    const feedToken = body.feed_token;
    if (typeof feedToken !== 'string' || feedToken === '') {
      return new Response('missing or invalid feed_token', { status: 400 });
    }
    return sendTestPush({ channel, pushToken, subscription, feedToken }, env);
  }
  return new Response('not found', { status: 404 });
}

export interface RegisterParams {
  channel: Channel;
  // Expo push token, or, when subscription is set, the webpush subscription's own endpoint URL.
  // Either way, this is the KV key discriminator for this device.
  pushToken: string;
  subscription?: PushSubscription;
  filter: ContentFilter;
  authors: string[];
  minLength: number;
  feedToken: string;
}

// All inputs are assumed pre-validated (non-empty pushToken, known channel, valid filter,
// non-empty feedToken) — validation lives at the HTTP boundary in fetch(). This function
// only encodes the access/storage decision, so it can be unit tested with plain objects,
// no Request/env plumbing.
export async function registerDevice(
  { channel, pushToken, subscription, filter, authors, minLength, feedToken }: RegisterParams,
  env: Pick<Env, 'TOKENS' | 'STATE'>,
): Promise<Response> {
  const access = await feedTokenHasAccess(channel, feedToken);
  if (access === null) {
    return new Response('access check failed, try again', { status: 503 });
  }
  if (!access) {
    return new Response('no access', { status: 403 });
  }
  await env.STATE.put(`poll:${channel}`, feedToken);

  // lastValidated is stamped now, not left undefined — access was just confirmed above, so
  // there's no need for the next validation sweep to immediately recheck a registration that's
  // seconds old (see ValidationQueueMessage/needsRevalidation, issue #86).
  const lastValidated = Date.now();
  // kind/subscription are only ever written for a webpush registration (see TokenMeta).
  // Omitting them entirely for an Expo registration keeps every pre-existing entry's shape
  // unchanged.
  const meta: TokenMeta = subscription
    ? { feedToken, filter, authors: authors.map((a) => a.trim().toLowerCase()), minLength, kind: 'webpush', subscription, lastValidated }
    : { feedToken, filter, authors: authors.map((a) => a.trim().toLowerCase()), minLength, lastValidated };
  const kvKey = subscription ? `${channel}:web:${pushToken}` : `${channel}:${pushToken}`;
  // No expirationTtl: registrations don't expire on a timer. Cleanup relies entirely on
  // gone-detection (drainWebPushQueue/drainValidationQueue prune on a confirmed-dead webpush
  // endpoint) and access-revalidation (deletes once feedTokenHasAccess is confirmed false) — a
  // time-based TTL was tried first (issue #60) and removed once those two mechanisms existed:
  // it only ever protected a narrow gap neither one reaches (a channel with a dead device that
  // never gets a real send attempted, on a feedToken whose WordPress access never lapses), judged
  // not worth its ongoing cost for how rarely it would actually matter.
  await env.TOKENS.put(kvKey, '1', { metadata: meta });
  return new Response('ok');
}

export interface TestPushParams {
  channel: Channel;
  pushToken: string;
  subscription?: PushSubscription;
  feedToken: string;
}

// Bypasses the poll/detect/filter pipeline, to confirm a registration actually receives pushes
// through the same delivery path a real alert would use.
//
// Uses the same feed_token gate as registerDevice. This proves access before sending, so it
// can't be used to spam an arbitrary subscription.
export async function sendTestPush(
  { channel, pushToken, subscription, feedToken }: TestPushParams,
  env: Pick<Env, 'WEBPUSH_QUEUE'>,
): Promise<Response> {
  const access = await feedTokenHasAccess(channel, feedToken);
  if (access === null) {
    return new Response('access check failed, try again', { status: 503 });
  }
  if (!access) {
    return new Response('no access', { status: 403 });
  }

  const title = 'Test notification';
  const body = 'If you can see this, push notifications are working.';

  if (subscription) {
    // Enqueued through the same WEBPUSH_QUEUE runChannel uses, rather than sent inline, so this
    // exercises the real delivery path (queue wiring, deployed consumer) instead of a shortcut
    // that could report success while the operational path is broken. 'ok' means queued, not
    // confirmed delivered — the encrypted send, and any resulting subscription-pruning, happens
    // in the queue() consumer, asynchronously.
    try {
      await env.WEBPUSH_QUEUE.sendBatch([{ body: { channel, subscription, title, body } }]);
      return new Response('ok');
    } catch {
      return new Response('enqueue failed', { status: 502 });
    }
  }

  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ to: pushToken, title, body }]),
    });
    return res.ok ? new Response('ok') : new Response('send failed', { status: 502 });
  } catch {
    return new Response('send failed', { status: 502 });
  }
}

// Tri-state: true/false are definitive, null means the check itself failed (network error, 5xx,
// timeout) and access is unknown — callers must not treat null as "no access" or a transient blip
// permanently deletes registrations.
// The real revocation signal is item count: verified against the live server, this endpoint
// always returns HTTP 200 regardless of token validity, so the 401/403 branch below is defensive
// only and never fires in practice. CHANNEL_FEEDS[channel][0] is chosen per-channel specifically
// so this is always a feed that requires a valid token to return anything (see CHANNEL_FEEDS
// comment) — item count is a reliable signal only because of that choice.
export async function feedTokenHasAccess(channel: Channel, feedToken: string): Promise<boolean | null> {
  try {
    const res = await fetch(`${CHANNEL_FEEDS[channel][0].url}?feed_token=${feedToken}`);
    if (res.status === 401 || res.status === 403) return false;
    if (!res.ok) return null;
    const raw = parser.parse(await res.text())?.rss?.channel?.item ?? [];
    return (Array.isArray(raw) ? raw : [raw]).length > 0;
  } catch { return null; }
}

// Iterates registered users for a channel to find one whose feedToken
// returns content, then stores it as the new poll token.
export async function findAndStorePollToken(channel: Channel, env: Pick<Env, 'TOKENS' | 'STATE'>): Promise<string | null> {
  let cursor: string | undefined;
  do {
    const page = await env.TOKENS.list<TokenMeta>({ prefix: `${channel}:`, cursor });
    for (const key of page.keys) {
      const feedToken = key.metadata?.feedToken;
      if (!feedToken) continue;
      if (await feedTokenHasAccess(channel, feedToken)) {
        await env.STATE.put(`poll:${channel}`, feedToken);
        return feedToken;
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return null;
}

interface Bucket { filter: ContentFilter; authors: string[]; minLength: number; tokens: string[]; webpushSubs: PushSubscription[] }

// Web Push has no bulk-send endpoint, so one queue message = one (subscriber, item) send. The
// consumer (see the queue() handler below) does the actual encryption/fetch, in its own
// invocation with its own 50-subrequest budget, separate from the polling cron's.
export interface WebPushQueueMessage {
  channel: Channel;
  subscription: PushSubscription;
  title: string;
  body: string;
  url?: string;
}

// Cloudflare Queues caps sendBatch() at 100 messages per call.
const QUEUE_SEND_BATCH_SIZE = 100;

// One message = one (channel, registration) pair to revalidate — never one per feedToken value.
// The same feedToken is registered separately per channel (one TOKENS entry each), and access is
// genuinely per-channel: a token can retain Members access while losing Stock or Options access
// independently. channel travels with every message specifically so the consumer always checks
// the channel-appropriate URL (feedTokenHasAccess picks it from CHANNEL_FEEDS[channel]) — never
// inferred or assumed shared across a token's other registrations.
//
// meta is a snapshot from the TOKENS.list() call that found this entry stale enough to enqueue —
// the consumer needs the full metadata to rewrite the entry on a successful revalidation (KV
// put() replaces metadata wholesale, no partial-patch API).
export interface ValidationQueueMessage {
  channel: Channel;
  tokenKey: string;
  meta: TokenMeta;
}

// Re-reads `daily` fresh from KV right before a write that follows slow work (bucket-building,
// push-sending). A duplicate cron dispatch for the same channel can complete its own write in
// that window; basing the next advanceDaily() call on a stale in-memory snapshot instead of a
// fresh read would silently lose that invocation's contribution to the daily counters.
async function freshDailyBase(env: Pick<Env, 'STATE'>, runKey: string, fallback: DailyStats | undefined): Promise<DailyStats | undefined> {
  const raw = await env.STATE.get(runKey);
  return raw ? (JSON.parse(raw) as ChannelState).daily : fallback;
}

async function runChannel(channel: Channel, env: Env, event: ScheduledEvent): Promise<void> {
  const now = new Date();
  const intervals = {
    trading:  parseInt(env.POLL_INTERVAL_TRADING  ?? '5',  10),
    lateday:  parseInt(env.POLL_INTERVAL_LATEDAY  ?? '15', 10),
    overnight: parseInt(env.POLL_INTERVAL_OVERNIGHT ?? '60', 10),
  };
  const boundaries = {
    open:    hhmmToMinutes(env.POLL_BOUNDARY_OPEN    ?? '0915'),
    lateday: hhmmToMinutes(env.POLL_BOUNDARY_LATEDAY ?? '1400'),
    close:   hhmmToMinutes(env.POLL_BOUNDARY_CLOSE   ?? '1615'),
  };
  // Despite the 5–60 min poll cadence above, content can still surface as newly-seen well after
  // publish — cap how old something can be and still get pushed (issue #48).
  const maxPushAgeMs = parseInt(env.MAX_PUSH_AGE_MINUTES ?? '120', 10) * 60 * 1000;
  // Cap on how many of a forum's most-recent posts are ever considered for alerting, independent
  // of how many the upstream RSS feed happens to return today — full history/backlog is the
  // app's job (its own reconciliation on every foreground refresh), not the Worker's. See
  // "Server-side alerting model" in the design doc for why a cap exists at all.
  const maxAlertItemsPerFeed = parseInt(env.MAX_ALERT_ITEMS_PER_FEED ?? '25', 10);
  // Who can trigger the 'actionable' tier.
  const actionableAuthors = (env.ACTIONABLE_AUTHORS ?? 'Sean Hyman').split(',').map((a) => a.trim().toLowerCase());
  const runKey = `run:${channel}`; // see ChannelState
  const runRaw = await env.STATE.get(runKey);
  const state: ChannelState | null = runRaw ? JSON.parse(runRaw) : null;
  const lastRun = state?.stats.lastRun ? new Date(state.stats.lastRun) : null;
  if (!shouldPollNow(now, lastRun, getIntervalMinutes(now, intervals, boundaries))) return;

  // Cron Triggers are at-least-once delivery — Cloudflare's own docs: "rare duplicate
  // executions possible." event.scheduledTime identifies the logical tick and stays identical
  // across duplicate deliveries of it (unlike wall-clock `now`, which differs between them). If
  // a prior invocation already claimed this exact tick, this is a duplicate: stop before
  // touching the network or KV again, and tell Cloudflare not to retry it either.
  if (state?.stats.lastScheduledTime === event.scheduledTime) {
    event.noRetry();
    return;
  }

  const feedToken = await env.STATE.get(`poll:${channel}`);
  if (!feedToken) return; // no subscriber has registered for this channel yet

  // Claim this tick now, before any network fetch — the earliest point possible, narrowing the
  // duplicate-dispatch race to "two reads landing before either write," the minimum achievable
  // without KV compare-and-swap (KV has none, so this is a mitigation, not a hard guarantee).
  // seen/daily are carried forward unchanged; the closing write below finalizes them once the
  // (possibly slow) fetch/notify work completes.
  const claimedStats: RunStats = { ...(state?.stats ?? emptyRunStats()), lastRun: now.toISOString(), lastScheduledTime: event.scheduledTime };
  await env.STATE.put(runKey, JSON.stringify({
    stats: claimedStats, seen: state?.seen ?? {}, daily: state?.daily ?? emptyDaily(getETDate(now)),
    lastValidationEnqueueDate: state?.lastValidationEnqueueDate,
  } satisfies ChannelState));

  const seenMap: Partial<Record<string, string[]>> = state?.seen ?? {};

  // Per forum: fetch the top-level feed only (no topic sub-feeds — see design doc), cap to the
  // most recent maxAlertItemsPerFeed, and — since these feeds are confirmed reverse-chronological
  // — walk from newest until the first already-seen guid, then stop. Everything past that point
  // must already be seen too, so there's no need to scan further. The freshness check (issue #48)
  // happens in the same walk rather than as a separate pass, and each feed's fresh items are
  // reversed before collecting so alerting processes oldest-to-newest — a user who missed several
  // posts sees them in reading order, not newest-first.
  let itemsFetched = 0;
  const newItems: RssItem[] = [];
  const freshItems: RssItem[] = [];
  for (const feed of CHANNEL_FEEDS[channel]) {
    try {
      const res = await fetch(`${feed.url}?feed_token=${feedToken}`);
      if (!res.ok) continue;
      const items: RssItem[] = extractRssItems(parser.parse(await res.text()))
        .slice(0, maxAlertItemsPerFeed)
        .map((rssItem) => ({ ...rssItem, feedKey: feed.feedKey }));
      itemsFetched += items.length;

      const seenList = seenMap[feed.feedKey];
      if (seenList === undefined) {
        // First ever poll for this feed: seed known guids without notifying (avoids a
        // flood on day one, same reasoning as the app's own first-run seeding).
        seenMap[feed.feedKey] = items.map((i) => i.guid).slice(0, MAX_SEEN_IDS_PER_FEED);
        continue;
      }
      const seenSet = new Set(seenList);
      const newForFeed: RssItem[] = [];
      const freshForFeed: RssItem[] = [];
      for (const item of items) {
        if (seenSet.has(item.guid)) break;
        newForFeed.push(item);
        if (isFresh(item.pubDate, maxPushAgeMs)) freshForFeed.push(item);
      }
      newItems.push(...newForFeed);
      freshItems.push(...freshForFeed.reverse());
      seenMap[feed.feedKey] = [...newForFeed.map((i) => i.guid), ...seenList].slice(0, MAX_SEEN_IDS_PER_FEED);
    } catch { /* skip failed feed */ }
  }

  // Valid tokens always return items for Members Forum/Stock/Options Insights, which require a
  // real token to return anything; Members Area returns items regardless of token validity (only
  // the content snippet is paywalled), so a stale token for the 'members' channel can still show
  // itemsFetched > 0 here. That's a pre-existing gap in lapsed-subscription detection for that
  // channel specifically, not something this change introduces — tracked in issue #58.
  if (itemsFetched === 0) {
    await findAndStorePollToken(channel, env);
    return; // recovered token (if any) will be used on the next cron cycle
  }

  const runStats: RunStats = { lastRun: now.toISOString(), lastNotified: null, itemsFetched, numNewItems: newItems.length, sent: 0, lastScheduledTime: event.scheduledTime };
  const todayET = getETDate(now);

  if (newItems.length === 0) {
    // The fetch loop above already ran (network I/O — "slow work"), so daily's base is re-read
    // fresh here rather than trusting the pre-fetch snapshot, same reasoning as the branches below.
    // No validation scan happened — that only runs once the notify-worthy bucket-building loop
    // below is reached — so lastValidationEnqueueDate carries forward unchanged.
    const daily = advanceDaily(await freshDailyBase(env, runKey, state?.daily), todayET, runStats);
    await env.STATE.put(runKey, JSON.stringify({
      stats: runStats, seen: seenMap, daily, lastValidationEnqueueDate: state?.lastValidationEnqueueDate,
    } satisfies ChannelState));
    return;
  }

  // Access is only checked at registration time (registerDevice) otherwise. A subscription can
  // lapse afterward, so devices are periodically revalidated — same signal findAndStorePollToken
  // uses for stale tokens — to prune access-revoked registrations before they get another
  // channel's worth of content pushed to them. This no longer happens inline here: it used to,
  // gated to once per ET day per channel, but even gated to once/day the recheck itself was still
  // one synchronous fetch per device in a single invocation, so a channel with enough registered
  // devices could still exceed the free plan's 50-subrequest-per-invocation cap on the one tick
  // where the sweep ran — throwing and aborting the whole tick's notifications for everyone on
  // the channel, not just the overflow devices (issue #86).
  //
  // Instead, this loop only collects which registrations are stale enough to revalidate — no
  // fetch() calls, so no subrequest cost regardless of device count — and hands them to
  // VALIDATION_QUEUE below. The actual feedTokenHasAccess fetch happens in the queue() consumer,
  // in its own invocation with its own subrequest budget, bounded by wrangler.toml's consumer
  // max_batch_size the same way webpush sends are. Real tradeoff, unchanged from before: a
  // revoked subscriber can keep receiving pushes for up to a day before being pruned, instead of
  // immediately — but this now holds at any device count, not just up to roughly the 40s.
  //
  // Gated at two levels: lastValidationEnqueueDate (once per ~24h per channel) avoids scanning
  // TOKENS at all on every tick, and each registration's own lastValidated (stamped here and at
  // registration time) avoids re-enqueueing a device that was already validated recently.
  const nowMs = now.getTime();
  const doValidationEnqueue = needsRevalidation(state?.lastValidationEnqueueDate, nowMs);
  const validationMessages: MessageSendRequest<ValidationQueueMessage>[] = [];
  const buckets = new Map<string, Bucket>();
  let cursor: string | undefined;
  do {
    const page = await env.TOKENS.list<TokenMeta>({ prefix: `${channel}:`, cursor });
    for (const key of page.keys) {
      const meta = key.metadata;
      // One message per (channel, registration) pair — never merged across channels. The same
      // feedToken can be registered separately per channel, and access is genuinely per-channel
      // (a token can keep Members access while losing Stock or Options access independently), so
      // channel travels with the message and the consumer always checks the channel-appropriate
      // URL (feedTokenHasAccess picks it from CHANNEL_FEEDS[channel]), never a shared/inferred one.
      if (doValidationEnqueue && meta?.feedToken && needsRevalidation(meta.lastValidated, nowMs)) {
        validationMessages.push({ body: { channel, tokenKey: key.name, meta } });
      }
      const { filter, authors, minLength, kind, subscription } = meta ?? {};
      if (!filter || authors === undefined || minLength === undefined) continue; // pre-redesign entry — skip until it re-registers
      // Devices sharing filter+authors+minLength get one shared eligibility check per item below
      // instead of one per device — negligible cost even at hundreds of distinct buckets.
      const sig = `${filter}|${authors.join(',')}|${minLength}`;
      const bucket = buckets.get(sig) ?? { filter, authors, minLength, tokens: [], webpushSubs: [] };
      if (kind === 'webpush' && subscription) {
        bucket.webpushSubs.push(subscription);
      } else {
        bucket.tokens.push(key.name.slice(channel.length + 1));
      }
      buckets.set(sig, bucket);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  if (validationMessages.length > 0) {
    try {
      for (let i = 0; i < validationMessages.length; i += QUEUE_SEND_BATCH_SIZE) {
        await env.VALIDATION_QUEUE.sendBatch(validationMessages.slice(i, i + QUEUE_SEND_BATCH_SIZE));
      }
    } catch { /* enqueueing today's validation sweep failed; notifications below are unaffected */ }
  }

  const lastValidationEnqueueDate = doValidationEnqueue ? nowMs : state?.lastValidationEnqueueDate;

  if (buckets.size === 0) {
    const daily = advanceDaily(await freshDailyBase(env, runKey, state?.daily), todayET, runStats);
    await env.STATE.put(runKey, JSON.stringify({
      stats: runStats, seen: seenMap, daily, lastValidationEnqueueDate,
    } satisfies ChannelState));
    return;
  }

  // Classify every fresh item once here, shared by every bucket below — not once per bucket. A
  // live embedding call from inside the per-bucket loop would re-embed the same post once per
  // bucket, wasting latency and Workers AI neuron budget. `members` is checked first and
  // short-circuits `actionable` entirely (regex and embeddings both skipped) since Members Area
  // bypasses every filter tier regardless of actionable-ness.
  //
  // The hybrid classifier covers every non-Members-Area feed. Each feed's own ActionableStrategy
  // (actionableStrategyFor in @li/core) supplies both which regex patterns count as definitive and
  // which calibration set the embedding fallback compares against -- Members Forum and Stock
  // Insights share the stock-pick strategy (both stock-pick content, differing only in the
  // star-gate Stock Insights requires; Members Forum is bundled under the 'members' channel for
  // push-registration purposes only, unrelated to this), Options Insights has its own.
  const classifications = new Map<string, ItemClassification>();
  const hybridCandidates: RssItem[] = [];
  for (const rssItem of freshItems) {
    const fi = toFilterItem(rssItem);
    if (fi.feedKey === FeedKeys.membersArea) {
      classifications.set(rssItem.guid, { members: true, actionable: false });
      continue;
    }
    const text = fi.content ?? '';
    const strategy = actionableStrategyFor(fi.feedKey);
    // isSignalUndecided must be checked here too, not just inside classifyActionableHybrid -- an
    // item classifySignal already has a definitive opinion on (positive, negative, or missing an
    // action verb) shouldn't be sent to the AI batch as a "candidate" in the first place.
    const regexUndecided = isSignalUndecided(classifySignal(text, 0, strategy.posPatterns));
    if (regexUndecided && isActionableCandidate(fi, actionableAuthors)) {
      hybridCandidates.push(rssItem); // resolved after the batch AI call below
      continue;
    }
    classifications.set(rssItem.guid, { members: false, actionable: isActionablePost(fi, actionableAuthors) });
  }

  if (hybridCandidates.length > 0) {
    try {
      const texts = hybridCandidates.map((rssItem) => rssItem.description);
      const result = await env.AI.run('@cf/baai/bge-large-en-v1.5', { text: texts }) as { data: number[][] };
      hybridCandidates.forEach((rssItem, i) => {
        const strategy = actionableStrategyFor(rssItem.feedKey);
        const hybrid = classifyActionableHybrid(rssItem.description, result.data[i], strategy.calibration, strategy.posPatterns);
        classifications.set(rssItem.guid, { members: false, actionable: hybrid.isActionable });
      });
    } catch {
      // AI call failed this cycle -- these candidates already know regex was undecided, so they
      // fall back to not-actionable, identical to today's pre-wiring behavior for this content.
      hybridCandidates.forEach((rssItem) => classifications.set(rssItem.guid, { members: false, actionable: false }));
    }
  }

  // Push-sends are independent per bucket, so they run concurrently rather than one at a time —
  // this shortens wall-clock duration (fetch() wait doesn't count against the Worker's CPU-time
  // limit either way, but a shorter invocation is still less exposed to Cloudflare's separate
  // wall-clock duration cap). A failure in one bucket's send must not skip the others.
  const sentCounts = await Promise.all(
    Array.from(buckets.values()).map(async (bucket) => {
      const toNotify = freshItems
        .filter((item) => matchesFilter(toFilterItem(item), bucket.filter, bucket.authors, bucket.minLength, classifications.get(item.guid)!))
        .slice(0, 5);
      if (toNotify.length === 0) return 0;

      let sent = 0;

      if (bucket.tokens.length > 0) {
        const messages = toNotify.map((item, i) => ({
          to: bucket.tokens,
          title: formatTitle(item),
          body: item.description.slice(0, 150) || 'New post',
          sound: i === 0 ? 'default' : undefined,
        }));

        try {
          await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(messages),
          });
          sent += toNotify.length;
        } catch { /* this bucket's Expo send failed; webpush sends below are unaffected */ }
      }

      if (bucket.webpushSubs.length > 0) {
        // Web Push has no bulk-send endpoint, so every (subscriber, item) pair is queued as its
        // own message rather than sent inline here — the actual encrypted send happens in the
        // queue() consumer below, in its own invocation with its own subrequest budget. This
        // invocation only pays for the queue.sendBatch() calls, not for len(subs)*len(items)
        // fetches.
        const messages: MessageSendRequest<WebPushQueueMessage>[] = bucket.webpushSubs.flatMap((sub) =>
          toNotify.map((item) => ({
            body: { channel, subscription: sub, title: formatTitle(item), body: item.description.slice(0, 150) || 'New post', url: item.link },
          }))
        );
        try {
          for (let i = 0; i < messages.length; i += QUEUE_SEND_BATCH_SIZE) {
            await env.WEBPUSH_QUEUE.sendBatch(messages.slice(i, i + QUEUE_SEND_BATCH_SIZE));
          }
          sent += toNotify.length;
        } catch { /* this bucket's webpush enqueue failed; other buckets are unaffected */ }
      }

      return sent;
    })
  );
  runStats.sent = sentCounts.reduce((a, b) => a + b, 0);
  if (runStats.sent > 0) runStats.lastNotified = now.toISOString();

  const daily = advanceDaily(await freshDailyBase(env, runKey, state?.daily), todayET, runStats);
  await env.STATE.put(runKey, JSON.stringify({
    stats: runStats, seen: seenMap, daily, lastValidationEnqueueDate,
  } satisfies ChannelState));
}

export { matchesFilter, stripReplyPrefix } from '@li/core';
