# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Shell Command Rules

**ALWAYS use subshell syntax for directory changes. Never use bare `cd`.**

```bash
# CORRECT
(cd cloudflare-worker && npm test)

# WRONG — never do this
cd cloudflare-worker && npm test
```

The Bash tool shell state persists across calls.
A bare `cd` leaves the working directory wrong for subsequent calls.

## Project Overview

LogicalInvestor is a push-notification backend for logicalinvestor.net, a paywalled WordPress/bbPress forum site.
There is no app.
A single Cloudflare Worker polls the site's RSS feeds on a cron schedule, classifies new posts, and delivers Web Push notifications to browsers registered through a static registration page.
Registration and classification are both gated on a per-user `feed_token` obtained from the site.

A React Native/Expo companion app existed earlier in this project's life (full RSS browsing, in-app read tracking, iCloud sync) but was removed from this repository.
See the `expo-app-final` git tag for its last complete state, and `RELEASES.md` for what changed when it was removed.
The Worker and `web-push/` are unaffected by that history and are the entire surviving product.

## Development Environment

**Node:** Node 24 LTS via fnm (Fast Node Manager), **NOT system Node**

`cloudflare-worker/` and `packages/core/` are each independent npm projects (own `package.json`, own `node_modules`).
There is no root-level `package.json` or npm workspace.
Run `npm install` inside each one you're working on.

fnm's default `--version-file-strategy` is `local` — it checks only the exact current directory for a `.node-version` file, it does not walk up to parent directories, and a pin in one directory does not propagate down to subdirectories.
Each directory that does Node work needs its own `.node-version` file; `cloudflare-worker/` and `packages/core/` each have one.

## Development Workflow

Feature branches merge to `main`: `feature/<slug>` (e.g. `feature/notification-filter-redesign`), `fix/<slug>`, `docs/<slug>`, `chore/<slug>`.
This repo squash-merges every PR — see the global git workflow notes (`~/.claude/CLAUDE.md`) for what that implies for branch stacking and issue-number tagging.

Track planned work, bugs, and open questions as GitHub Issues — not in this file.
A roadmap list here goes stale the moment work lands and nobody remembers to edit it back out.
Before committing a fix for a bug reported conversationally (no issue number given), check `gh issue list --search "<keyword>"` — it may already be filed.

Never run `wrangler deploy`, or ask about deploying the Cloudflare Worker — the user always deploys it themselves.

Don't probe the live logicalinvestor.net site with curl to test a hypothesis about URL/routing/feed behavior.
Ask the user directly — they have first-hand knowledge of how the site works.

## Tech Stack

- **Runtime**: Cloudflare Workers, TypeScript strict mode
- **Storage**: Workers KV (`TOKENS`, `STATE` namespaces)
- **Queues**: Cloudflare Queues (`WEBPUSH_QUEUE`, `VALIDATION_QUEUE`)
- **AI**: Workers AI (`llama-3.3-70b-instruct-fp8-fast`) for intent classification
- **Push delivery**: Web Push only (`@block65/webcrypto-web-push`), to browsers registered via `web-push/`
- **Feed parsing**: `fast-xml-parser`
- **Testing**: `vitest` (Worker), `jest`/`ts-jest` (`packages/core`)
- **Deployment**: `wrangler`

## Commands

### Cloudflare Worker (`cloudflare-worker/`)
```bash
npm install --prefix cloudflare-worker      # Install dependencies
npm test --prefix cloudflare-worker         # Run Worker test suite
npm test --prefix cloudflare-worker -- <path>  # Run a specific test file
(cd cloudflare-worker && npx tsc -p tsconfig.json)  # Typecheck
(cd cloudflare-worker && npm run dev)       # Local dev server (wrangler dev)
```

### Shared core (`packages/core/`)
```bash
npm install --prefix packages/core          # Install dependencies
npm test --prefix packages/core             # Run core test suite
npm run typecheck --prefix packages/core    # Typecheck
```

### Deployment
See "Deploying with a version tag" below.
The user runs this themselves — never `wrangler deploy` directly, and never on Claude's own initiative.

## Architecture

### Core Principle

No backend beyond this one Worker.
It talks directly to logicalinvestor.net, authenticated via a per-user feed token appended as `?feed_token=<token>` to every feed URL.
It has two jobs: poll feeds on a cron schedule and classify what's new, and serve `web-push/`'s registration API.

### Cloudflare Worker (`cloudflare-worker/src/index.ts`)

**Registration**: `POST /register` takes a browser Web Push subscription (`{ subscription: { endpoint, keys: { p256dh, auth } }, channel, filter, authors, minLength, feed_token }`).
`feed_token` is verified against the channel's feed before the registration is stored — required on every call.
For Stock/Options Insights it also proves access, rejected with 403 if missing, invalid, or the account isn't subscribed to that channel.

- `channel` — `'members' | 'stock' | 'options'`
- `filter` — `'members' | 'actionable' | 'length'` (see `@li/core`'s `ContentFilter`)
- `authors` — string[], substring whitelist; `[]` = no author restriction (no global fallback)
- `minLength` — number; `0` = no minimum

`POST /unregister` removes a registration.
`POST /test-push` sends one notification straight to the requesting registration, bypassing the poll/filter pipeline entirely, to confirm delivery without waiting for real forum activity.
It's enqueued through the same `WEBPUSH_QUEUE` a real alert uses, so `ok` there means queued, not confirmed delivered.

**Polling** (`scheduled()`, driven by three Cron Triggers, one per channel — see `wrangler.toml`'s `channelFromCron` comment for how the minute-field offset maps a cron to a channel):
per forum, fetch the top-level feed only.
No per-topic sub-feeds are needed — the top-level "All Posts" feed already contains every reply in that forum, confirmed against a real authenticated fetch.
Capped to the most recent `MAX_ALERT_ITEMS_PER_FEED` items, walking newest-to-oldest until the first already-seen guid.
Poll interval varies by time of day (`getIntervalMinutes`): 5 min during trading hours, 15 min in the late-day window, 60 min overnight/weekends — all configurable via `POLL_INTERVAL_*`/`POLL_BOUNDARY_*` vars.
Content older than `MAX_PUSH_AGE_MINUTES` (default 120) when first observed is never pushed even if newly-seen (issue #48).
There's no separate reconciliation pass anywhere else — the poll's item cap is the only view of feed history that exists.

**Classification, once per item per poll cycle** (`runChannel`): before the per-bucket notification
loop, every fresh item is resolved once into an `ItemClassification` (`@li/core`):
`{ members: boolean, actionable: boolean }`.
`members` is checked first — a plain `feedKey === membersArea` comparison —
and short-circuits `actionable` entirely (never computed) whenever it's true,
since Members Area bypasses every tier regardless of actionable-ness.
When `members` is false,
`actionable` is resolved against that item's own feed's `ActionableStrategy`
(`actionableStrategyFor(feedKey)`, `@li/core`) —
its `posPatterns`, one set per forum's discourse rather than a feed-identity check at each call site:
Members Forum and Stock Insights share `STOCK_PICK_STRATEGY` (tranche-pricing vocabulary),
Options Insights has its own `OPTIONS_STRATEGY` (strike/expiry contract vocabulary).
Given a strategy, `actionable` is resolved by whichever of these applies:
- **`classifySignal` matches a pattern in that item's own forum strategy `needsIntentConfirmation` set**
  (`ActionableStrategy`, `@li/core`: stock has
  `pass-sell-fraction`/`pass-close-enough`/`pass-get-now`/`pass-buy-with-price`,
  options has `pass-options-contract`) —
  regex deliberately tuned for recall over precision,
  since the same trigger phrase ("sell half", a strike+expiry mention)
  is used identically by a genuine broadcast directive, personal advice to one reader,
  and general strategy education;
  measured leave-one-out accuracy shows every other pattern in the calibration corpus
  is 100% correct, these aren't.
  Each such item gets one call (not batched — unlike embeddings,
  chat completion has no batch input shape) to `classifyActionableIntent`
  (`cloudflare-worker/src/intentClassifier.ts`):
  a Workers AI chat call (`llama-3.3-70b-instruct-fp8-fast`, schema-enforced JSON Mode)
  using the calling forum's own `IntentStrategy` (`intentStrategyFor(feedKey)` —
  `STOCK_INTENT_STRATEGY` or `OPTIONS_INTENT_STRATEGY`, a separate prompt and few-shot set
  per discourse, mirroring `ActionableStrategy`'s own per-forum separation)
  that classifies the post as `directive`/`personal-advice`/`general-education`
  with a stated confidence.
  `resolveIntentGate` (`@li/core`) only suppresses the alert on a *confident* (`high`) verdict
  whose label is in the calling forum's own `suppressibleLabels` (`ActionableStrategy`, `@li/core`) —
  stock suppresses on `personal-advice` or `general-education`,
  options suppresses only on `general-education`,
  since an options reply naming a concrete strike and expiry is exactly as actionable
  as a broadcast one regardless of who it was nominally addressed to.
  Anything less than `high` confidence defaults to actionable,
  so the gate can only ever add a false alarm, never a missed alert.
  A failed/errored AI call falls back to the regex's own positive verdict
  (stays actionable) rather than blocking the run, for the same reason.
  Every decision — reasoning, evidence, label, confidence —
  is logged in `ChannelState.intentLog` (capped at the most recent 50 per channel)
  and surfaced via `GET /status`, riding along in the one KV write `runChannel`
  already makes per poll rather than costing an extra write per decision
  (Workers KV's free-tier write budget is already tight — see issue #32).
- **Otherwise** (regex already has a definitive opinion, `isActionablePost`, `@li/core`, regex-only,
  also used as the AI-failure fallback above):
  author is in the Worker's own `ACTIONABLE_AUTHORS` list (`env.ACTIONABLE_AUTHORS`, default "Sean Hyman")
  and content passes both the actionable-signal negative and positive pattern checks
  against that item's own feed's `posPatterns`.
  Content regex finds no signal in at all (`fail-no-signal`) resolves to not-actionable outright.
  There is no embedding/semantic fallback for this case — an earlier nearest-neighbor design was
  measured and removed; see the commit that deleted `packages/core/src/similarity.ts` for the numbers.
- **`isActionableCandidate`** (the author check both branches above run first) does not check the topic title at all.
  Sean's practice is to post the actionable content first and rename the topic to add a `*` afterward,
  so gating on the title at classification time would suppress the alert for exactly the content it's meant to catch.

**Dispatch, per bucket, reusing that classification.**
`matchesFilter(item, filter, authors, minLength, classification)` takes the already-resolved `ItemClassification`.
The three tiers (`FILTER_TIERS` in `@li/core`: `members`, `actionable`, `length`) are narrow to broad, each a strict superset of the one before it:
`members` alerts only when `classification.members`; `actionable` alerts when `classification.actionable`; `length` alerts on either `classification.actionable` or the device's own author whitelist with content at least `minLength` characters long.
Devices sharing filter+authors+minLength are grouped into one bucket, so eligibility is checked once per item per bucket, not once per device.

**Delivery**: Web Push only (`cloudflare-worker/src/webpush.ts`, wraps `@block65/webcrypto-web-push`).
WebCrypto-native, works unmodified in Workers — the canonical `web-push` npm package depends on Node `crypto` APIs Workers' `nodejs_compat` polyfill doesn't fully cover.
Web Push has no bulk-send endpoint, so every (subscriber, item) pair is queued as its own `WEBPUSH_QUEUE` message rather than sent inline.
The actual encrypted send happens in the `queue()` consumer, in its own invocation with its own 50-subrequest budget, bounded by `wrangler.toml`'s consumer `max_batch_size`.

**Registration cleanup has no time-based TTL.**
`registerDevice`'s `TOKENS.put()` sets no `expirationTtl` — a registration persists until something actively proves it should go.
Two independent mechanisms do the real cleanup work, neither of them time-based:

- **Gone-detection**: both `drainWebPushQueue` and `sendTestPush` prune a registration immediately when the push service itself reports the subscription no longer exists (HTTP 404/410, the Web Push protocol's own "gone" signal) — real, direct proof, not an inference.
  This only fires when a send is actually attempted, so it's opportunistic, not scheduled.
  Real forum activity (Sean posts to Members Area roughly weekly, a newsletter monthly) makes that frequent for most registrations.
- **Access revalidation** (issue #86): every registration's `feedToken` is periodically reconfirmed against its own channel, independent of whether there's anything to notify about, and pruned once access is confirmed revoked.
  This is what catches a subscription lapsing entirely (the person canceled), which gone-detection can never see on its own.

Access revalidation is fully decoupled from `runChannel`'s notify path.
`runChannel` no longer calls `feedTokenHasAccess` inline at all, so the notify-tick's subrequest budget is unaffected by registered-device count.
Two gates, both epoch-millisecond timestamps checked against a rolling 24h window via the same `needsRevalidation` predicate (a calendar-date string was tried first and rejected — see `needsRevalidation`'s own comment for why):
`lastValidationEnqueueDate` (`run:<channel>` STATE blob) gates a cheap `TOKENS` scan (no `fetch()` calls) to once per ~24h per channel, and each registration's own `lastValidated` (`TokenMeta`, stamped at registration time and after each successful revalidation) gates whether that specific registration is actually stale enough to enqueue.
Enqueueing hands off to `VALIDATION_QUEUE`.
Its consumer (`drainValidationQueue`, dispatched from the same `queue()` export that also drains `WEBPUSH_QUEUE`, distinguished via `batch.queue`) does the real `feedTokenHasAccess` fetch, bounded by `wrangler.toml`'s consumer `max_batch_size` the same way webpush sends are.
This is what lets the design scale to any registered-device count, not just up to the 50-subrequest ceiling a single invocation could ever process directly.
Real tradeoff: a revoked subscriber can keep receiving pushes for up to a day before being pruned, instead of immediately.

Every `ValidationQueueMessage` carries its own `channel` — access is genuinely per-channel (a token can retain Members access while losing Stock or Options access independently).
`feedTokenHasAccess(channel, feedToken)` picks the channel-appropriate URL internally, so messages are never merged or deduped by `feedToken` alone across channels.

**Deploying with a version tag**: `npm run deploy` (`cloudflare-worker/deploy.sh`) rather than a bare `wrangler deploy`.
It hard-blocks if `cloudflare-worker/`, `packages/core/`, or `web-push/` have uncommitted changes (the three paths that actually make up what this Worker deploys), then runs `wrangler deploy --tag "$(git rev-parse --short HEAD)" --message "<latest commit subject>"`.
The `[version_metadata]` binding (`wrangler.toml`) exposes that tag back to the running Worker as `env.CF_VERSION_METADATA`, surfaced in `GET /status`'s `version` field.
A live response, or a report of a live issue, always traces back to the exact commit that produced it.

**Checking Worker status**: `GET /status` requires the Worker's `FEED_TOKEN` secret as a Bearer header — not a query param, so it can't be checked by pasting a URL into a browser.
No `WWW-Authenticate` challenge is sent, so browsers won't prompt for credentials either.
Use curl:
```bash
curl -H "Authorization: Bearer $FEED_TOKEN" https://logicalinvestor-push.logicalinvestor.workers.dev/status
```
The Worker already pretty-prints the JSON response, so no `jq` needed.
`FEED_TOKEN` is the same secret set via `wrangler secret put FEED_TOKEN` — not stored in any file in this repo.

**Cron dead-man's-switch monitoring**: `/status` only tells you what happened on the last successful run — it can't tell you if runs have silently stopped happening.
On 2026-07-01/02 all three Cron Triggers (`members`/`stock`/`options`) stopped dispatching to `scheduled()` for ~15h with nothing anywhere surfacing an error (root cause: a stuck Cloudflare Cron Trigger registration, not application code; see issue #24).
To catch this class of failure:
- Each channel's cron pings its own healthchecks.io check (`HEARTBEAT_URL_MEMBERS` / `HEARTBEAT_URL_STOCK` / `HEARTBEAT_URL_OPTIONS`, Worker secrets) at the top of `scheduled()`, fire-and-forget via `ctx.waitUntil(...).catch(() => {})` — a hung or failing ping can't block the actual channel poll
- One check per channel, not one shared check: each cron entry in `wrangler.toml` is an independent Cloudflare Cron Trigger registration and can get stuck without the others being affected
- healthchecks.io checks are configured as **Simple** schedule (not Cron) — period 5 min, grace 15 min — matching how often each channel's cron actually fires; alerts by default go to the account email
- `heartbeatUrlFor(channel, env)` in `cloudflare-worker/src/index.ts` does the channel → secret lookup

### Web Push registration page (`web-push/`)

A static page (`index.html`, `app.js`, `sw.js`, `manifest.json`, icons, no build step) that registers a browser for push notifications.
It's a client of the Worker's API, not part of the Worker's own source.
It lives at the repo's top level, alongside `cloudflare-worker/` and `packages/core/`, instead of nested under `cloudflare-worker/`.
Sean Hyman declined to host it on logicalinvestor.net, so Cloudflare hosting is permanent — the Worker serves it via Workers Static Assets (`cloudflare-worker/wrangler.toml`'s `[assets] directory = "../web-push"`).
Local dev and phone testing use the same path: `wrangler dev` plus a `cloudflared tunnel --url`.

**Endpoints** (`cloudflare-worker/src/index.ts`):
- `GET /vapid-public-key`: the public key. The page never hardcodes a value that would go stale on rotation.
- `POST /test-push`: sends one notification straight to the requesting device, bypassing the poll/filter pipeline. Confirms a registration actually receives pushes without waiting for real forum activity.

**VAPID key pair**: production and local dev use deliberately different key pairs.
- Production: the public half is `wrangler.toml`'s committed `VAPID_PUBLIC_KEY` var.
  It isn't secret.
  The private half is set only via `wrangler secret put VAPID_PRIVATE_KEY`, and is never written to any file in this repo.
- Local dev: `cloudflare-worker/.dev.vars.example` holds a shared, committed, test-only key pair.
  Copy it to `.dev.vars`, which is gitignored.
  This pair has never been used in production and never will be, so there's nothing meaningful to keep secret about it.
  `.dev.vars` overrides `wrangler.toml`'s `[vars]` during `wrangler dev` only, never during a real deploy.
- To generate a new pair, needed only for a real production rotation: `npx web-push@3.6.7 generate-vapid-keys`.
  The version is pinned in the command instead of adding `web-push` as a project dependency, since it's a one-off human-run CLI utility never imported by any code.

**CORS**: `cloudflare-worker/src/index.ts`'s `fetch()` adds `Access-Control-Allow-Origin` for a single configured origin (`env.CORS_ALLOWED_ORIGIN`, a `wrangler.toml` var), plus `OPTIONS` preflight handling.
Same-origin requests, today's only real case, never trigger CORS enforcement.
This code is currently dormant.
No cross-origin host is configured, and none is planned.

### Shared core (`packages/core/`)

Framework-free TypeScript shared by the Worker: feed key/channel constants, RSS item extraction, HTML entity decoding, the `ContentFilter`/`matchesFilter` filter-tier logic, and the actionable-post classification (`ActionableStrategy`, `classifySignal`, `isActionablePost`, `resolveIntentGate`).
Has its own `package.json`, `node_modules`, and `jest`/`ts-jest` test suite — it's a standalone package, not a workspace member of anything else.
The Worker resolves `@li/core` via a `"file:../packages/core"` dependency in `cloudflare-worker/package.json`, which `npm install` turns into a real `node_modules/@li/core` symlink on a fresh clone.
`cloudflare-worker/tsconfig.json` also maps `@li/core` straight to `packages/core/src/index.ts` for `tsc`, pointing at the same file package.json's `main`/`types` fields already resolve to.

## Development Notes

- **Strict TypeScript**: both `cloudflare-worker/` and `packages/core/` use `strict: true`. Zero compiler errors.
- **No warnings tolerated**: lint/build warnings in `cloudflare-worker/src/` or `packages/core/src/` are never acceptable, including ones that pre-date a given change (see `~/.claude/CLAUDE.md`'s engineering defaults). Only warnings originating upstream (a dependency, generated code) may stand.
- **XML Parsing**: handles both single items and arrays in RSS channels (`fast-xml-parser`).
- **Error States**: a feed's real "no access" signal is zero items in the response, not an HTTP error — see `feedTokenHasAccess`'s comment in `cloudflare-worker/src/index.ts` for which feed is checked and why.

## File Structure

```
LogicalInvestor/
├── cloudflare-worker/
│   ├── src/
│   │   ├── index.ts             ← fetch()/scheduled()/queue() handlers, polling, classification, dispatch
│   │   ├── config.ts            ← CHANNEL_FEEDS (per-channel feed URLs)
│   │   ├── webpush.ts           ← Web Push send wrapper (@block65/webcrypto-web-push)
│   │   └── intentClassifier.ts  ← Workers AI intent-confirmation call
│   ├── wrangler.toml            ← bindings, cron triggers, static assets, version metadata
│   ├── deploy.sh                ← npm run deploy: dirty-check + tagged wrangler deploy
│   └── package.json
├── packages/
│   └── core/
│       ├── src/
│       │   ├── index.ts         ← shared feed/filter/classification logic
│       │   └── data/            ← classifier calibration sets
│       └── package.json
├── web-push/                    ← static registration page, served by the Worker
│   ├── index.html
│   ├── app.js
│   └── sw.js
├── docs/
│   └── notification-filter-design.md
├── RELEASES.md                  ← historical: the removed app's release history
└── LICENSE
```
