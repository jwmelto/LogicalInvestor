# Notification filter redesign

Status: design agreed, not yet implemented. Target: `release/0.10.0`.

## Problem

Local (on-device) notifications are the only way for a user to get alerts on
forum activity from an author other than Sean Hyman — server push
(`cloudflare-worker`) filters on a single global `AUTHOR_FILTER` var
(`wrangler.toml`), applied identically to every registered device. There is
no per-user customization today.

Local notifications rely on `expo-background-task`'s `BGProcessingTaskRequest`,
which is opportunistic — iOS grants it a background slot on its own schedule,
not on any interval the app requests. Verified via a physical device + Xcode
LLDB session (`e -l objc -- (void)[[BGTaskScheduler sharedScheduler]
_simulateLaunchForTaskWithIdentifier:...]`) that the task and the
lock-screen-notification path both work correctly in isolation — the gap is
purely that iOS rarely grants the background slot in practice, not a bug in
the implementation.

Conclusion: don't fight `BGTaskScheduler`. Move custom author filtering to
the server, onto the channel that's already reliable.

## Schema change

`TokenMeta` (Worker `TOKENS` KV metadata, already stored per registered
device) gains three optional fields:

```ts
interface TokenMeta {
  feedToken?: string;
  filter?: ContentFilter;  // replaces `level`
  authors?: string[];      // lowercased; empty/absent = fall back to global AUTHOR_FILTER
  minLength?: number;      // absent = fall back to global MIN_CONTENT_LENGTH
}
```

All new fields are optional and absent = today's exact behavior. No
migration needed for existing registrations.

## Filter tiers

Four tiers, narrow to broad, each a strict superset of the previous:

```
members → actionable → length → any
```

- `members`: Members Area posts only (no topics, so no content filter applies).
- `actionable`: rare, high-signal keyword matches (buy/sell/tranche/urgency
  phrases) — the narrowest non-members tier, because these patterns are rare.
- `length`: any post at least `minLength` characters — broader than
  `actionable`, since most substantive replies clear the bar.
- `any`: everything, content-wise.

Author match is a separate, always-required AND — it applies to every tier,
including `members` (moot in practice since only Sean posts there, but not
special-cased).

Each item collapses to a single ordinal `minVisibleTier`, computed once,
independent of any device:

```
minVisibleTier(item):
  if negative-pattern matches:            return ∞   (never notifies, any tier)
  if feedKey === membersArea:             return 0   (members)
  starOk = (stock/options) ? title.startsWith('*') : true
  if !starOk:                             return 3   (any — only the loosest tier ignores the star gate)
  if positive-pattern matches:            return 1   (actionable)
  if length >= minLength:                 return 2   (length)
  return 3                                            (any)
```

Device eligibility: `authorMatches(item, device.authors) AND
device.tierRank >= minVisibleTier(item)`.

**Behavior change, deliberate:** negative patterns (`fail-personal-advice`,
`fail-hypothetical`, `fail-historical`) become a universal veto across all
four tiers, not just the old `standard` tier. Without this, `actionable` and
`any` can't actually be supersets of each other where negative patterns
apply. Accepted as correct — nobody wants alerts on personal-advice-framed
content regardless of tier looseness.

**Known gap, accepted:** today's `minimal` level means "Members Area only,
suppress everything else." There's no equivalent under this design — every
tier applies to all forums, with Members Area just exempt from
content-filtering, not exempt from appearing. Dropped deliberately to avoid
forum-scoping as a second axis; revisit only if actually requested.

## Worker runtime changes

`runChannel`'s device bucketing changes from keying on `level` alone (3
possible buckets) to keying on `filter|authors|minLength` signature. This
still rides entirely on `TOKENS.list()` metadata, which already returns
these fields for free (existing comment in `cloudflare-worker/src/index.ts`
confirms metadata costs no extra KV read). `forum`/`actionable` computation
per item is unchanged; only `author` match gets recomputed per distinct
bucket signature — in-memory string comparison, negligible even at
hundreds of buckets.

## KV cost — zero marginal writes

Two KV namespaces, `TOKENS` (per-device) and `STATE` (per-channel), nothing
else. This feature adds no new namespace and no new write:

| Path | Writes today | Writes after |
|---|---|---|
| `/register` call | 1× `STATE.put(poll:)` + 1× `TOKENS.put(metadata)` | same 2 — new fields ride the existing metadata blob |
| `runChannel` per cron tick w/ new items | 5× `STATE.put` | same 5 |

**The free tier is already tight, independent of this feature.** Cron
polling alone runs ~250 times/day across 3 channels at 4–5 `STATE.put`
calls each ≈ 1,000–1,250 writes/day — at or past Cloudflare KV's free-tier
cap of 1,000 writes/day before this feature exists. A launch-day flood of
users editing settings simultaneously (2 writes per `/register` call) could
push over the cap on a highly visible day. No paid-tier budget exists for
this project currently (owner's explicit call — value has to be proven
before asking for the $5/month commitment).

Two concrete mitigations, not yet implemented:
1. Skip the redundant `STATE.put('poll:channel', ...)` write in
   `registerDevice()` when the feed token is unchanged from the stored value
   — read-before-write, halves the common-case registration write cost.
2. Debounce client-side sync — edit multiple Settings fields in one session,
   sync once (on leaving the screen), not once per field change.

The actual structural fix is moving off the free KV tier, independent of
this feature — cron traffic alone already justifies it. Not this repo's
call to make unilaterally.

## Scaling note (pre-existing, unrelated to this feature)

`runChannel`'s device-access-recheck loop (`cloudflare-worker/src/index.ts`,
inside the `TOKENS.list()` pass when there's new content to push) does a
sequential `for...of` with `await feedTokenHasAccess(...)` per device — one
WordPress HTTP round-trip at a time, not parallelized. At current device
counts this is negligible; if it ever grows to dozens+ devices, worth
switching to `Promise.all` per KV list page with a concurrency cap (avoid
bursting `logicalinvestor.net` with simultaneous requests). Pre-existing,
not introduced by this design — flagged here since it came up during the
same conversation.

## Consequence: local notifications become dead code

`notificationService.ts`'s `wouldServerPush()` already skips firing a local
notification whenever server push is predicted to cover the same item.
Once server push covers arbitrary custom author filters (this design),
`wouldServerPush()` becomes true for every item local would ever fire on —
local becomes permanently self-suppressing.

Follow-up candidates for removal once this ships:
- `backgroundFetchService.ts`, `registerBackgroundFetch()`, the
  `expo-background-task`/`expo-task-manager` wiring
- The local-notification scheduling path in `notificationService.ts`
- `app.json`'s `expo-background-task`/`expo-task-manager` plugin entries

Not done as part of this design — do it as its own cleanup PR after the
server-side change is live and confirmed working.

## Not yet done

- Worker: schema + bucketing + `matchesFilter`/`minVisibleTier` implementation
- App: `pushService.ts` sync of `authors`/`filter`/`minLength` to `/register`
  (mirroring the existing `updatePushLevel()` pattern), Settings UI for the
  four tiers
- The two KV-write mitigations above
- The dead-code removal follow-up
- Tests, both Worker and app side
