# Notification filter redesign

Status: design agreed, not yet implemented. Target branch:
`feature/notification-filter-redesign`.

## Problem

Local (on-device) notifications are the only way for a user to get alerts on
forum activity from an author other than Sean Hyman — server push
(`cloudflare-worker`) filters on a single global `AUTHOR_FILTER` var
(`wrangler.toml`), applied identically to every registered device.
There is no per-user customization today.

Local notifications rely on `expo-background-task`'s `BGProcessingTaskRequest`,
which is opportunistic — iOS grants it a background slot on its own schedule,
not on any interval the app requests.
Verified via a physical device + Xcode LLDB session that the task and the
lock-screen-notification path both work correctly in isolation — the gap is
purely that iOS rarely grants the background slot in practice, not a bug in
the implementation.

Conclusion: don't fight `BGTaskScheduler`.
Move custom author/content filtering to the server, onto the channel that's
already reliable, and remove the local pipeline entirely — see "Local
notifications are removed" below.

## Server-side alerting model

The server's actual job is narrower than the app's: the app is responsible
for complete, browsable forum history (hierarchical Forum → Topic → Posts,
lazy-loaded full topic threads, unread tracking) — the server's only job is
"tell me about anything worth an alert, soon." Those are different problems
with different correct implementations.

Confirmed against a real authenticated fetch of the Members Forum feed: the
top-level per-forum RSS feed (bbPress's "All Posts" feed) already aggregates
replies from every topic in that forum, not just new-topic creation — 25/25
sampled items were replies (`Reply To: ...`), spanning 8+ different topic
threads, in strict reverse-chronological order by `pubDate`. So the server
does not need topic-level tracking to see replies buried in existing topics
— the flat forum feed already surfaces them.

This means the Worker's topic-discovery/topic-sub-feed-fetching machinery
(`topics:<channel>` KV state, per-topic sub-feed fetches, `TOPIC_GC_DAYS`
pruning) is unnecessary for alerting, and is removed from the Worker
entirely. It remains purely an app-side concern (`topicService.ts`), used to
build the browsing UI and lazy-load a topic's full history — the server
never actually needed it for alerting.

**New server alerting function, per forum, per cron tick:**

```
for each forum in this channel:
  fetch the forum's RSS feed → up to N items (configurable), reverse-chronological
  walk from newest to oldest, collecting items, until the first
    already-seen guid is reached → stop (early exit)
  reverse the collected items back to oldest-first, so a device that missed
    several posts is alerted in reading order, not newest-first
  for each newly-seen item, oldest to newest:
    for each device registered to this channel:
      matchesFilter(item, device.filter, device.authors, device.minLength)
```

Bounding the candidate set to a single forum-feed fetch (no topic sub-feeds)
directly resolves three things that looked like separate problems during
review, but were all downstream of the same over-broad design:

- **CPU time.** This Worker runs on the Free plan (10ms CPU limit per
  invocation, including `scheduled()` cron ticks — the higher paid-plan cron
  allowances don't apply here). Parsing up to ~39 tracked topic sub-feeds in
  one invocation (confirmed via `wrangler kv key list --remote` against the
  live `STATE` namespace: 21 members + 10 stock + 8 options topics) is
  expensive; parsing one main feed per forum is not.
- **KV write budget.** Drops the unconditional `topicsKey` write from every
  poll (see "KV cost," below — this was already close to the 1,000/day
  free-tier cap from cron polling alone).
- **The new-topic alert flood** — a live bug, confirmed via production
  `daily:<channel>:<date>` history and a deploy-timeline check: only
  *feed-level* first-poll got the "seed quietly, don't notify" treatment
  topic sub-feeds relied on, so a topic discovered after its feed had
  already been polling for weeks got none of that protection, and its
  entire current reply window fired as brand new, all at once. There is no
  longer a "first time discovering this topic" event to mishandle — a
  newly-active topic's replies simply appear in the flat forum feed and go
  through the same seen-tracking every other post does.

**Complexity, deliberately accepted:** this is O(new items × registered
devices) per forum per poll. New items are capped per poll (configurable,
usually far fewer thanks to the early exit), so cost scales with device
count, not content volume. Per-device `matchesFilter` is cheap (a handful
of regex/string checks), so linear scaling in device count was accepted as
fine at current and foreseeable scale — revisit if device count grows
enough to matter.

**App vs. server responsibility, explicit:** the app still does its own
full reconciliation — complete topic history, unread tracking, hierarchical
browsing — on every foreground refresh, independent of the server. The
server's per-poll item cap is not a completeness guarantee and isn't meant
to be; it only bounds what's timely enough to alert on. The app needs the
deep dive; the server doesn't.

## Filter tiers

Three tiers, narrow to broad, each a strict superset of the previous:

```
members → actionable → length
```

- `members`: Members Area posts only — unconditional, see below.
- `actionable`: rare, high-signal keyword matches (buy/sell/tranche/urgency
  phrases), gated by topic requirements (see `minVisibleTier`, below).
- `length`: any post at least `minLength` characters, whether or not it also
  matched a keyword.

There is no `any`/"everything" tier: `filter: 'length', minLength: 0`
already covers it, since the length check always passes at 0.

### Members Area is unconditional, not just author-exempt

Author matching cannot apply uniformly to every tier — a device with a
narrow `authors` whitelist (e.g. `['herman']`) would otherwise silently
lose Members Area alerts too, exactly backwards from intent. The Members
Area is relevant to all users for alerting.

Every registered device receives Members Area alerts regardless of its
author whitelist or filter tier — `matchesFilter` returns `true`
unconditionally for that feed. The only way to stop them is to unregister
the device entirely (`/unregister`); there is no separate "off" setting.

### `minVisibleTier` — tier assignment rules

1. **A negative-pattern match only disqualifies a post from the
   `actionable` classification** — it is not a veto on visibility at any
   other tier. A long-enough negative-pattern post still surfaces at
   `length`. There is no tier, however narrow, that a device literally
   cannot reach.
2. **The star/topic gate applies only to the `actionable` classification,
   not to `length`.** Stock/Options Insights require a `*`-prefixed title
   to count as `actionable`; Members Forum has no such requirement. An
   unstarred Stock/Options Insights post that's simply long enough is still
   visible at `length`.

```
minVisibleTier(item, minLength):
  if feedKey === membersArea: return 0   (moot in practice — matchesFilter
                                           bypasses Members Area before this
                                           is ever consulted; kept here so
                                           the function is independently
                                           testable)
  topicPass = (stock/options) ? title.startsWith('*') : true
  actionable = topicPass && !negativePatternMatch && positivePatternMatch
  if actionable: return 1   (actionable)
  return (length >= minLength) ? 2 : 3   (length, or below this device's floor)
```

### Author matching — no global fallback, empty means unrestricted

There is no global default anymore, for anything. `filter`, `authors`, and
`minLength` are required on every device registration — the whole point of
this redesign is per-device alerting, not one-size-fits-all with overrides.
An empty `authors` list means exactly what it says: no author restriction.

## `TokenMeta` schema

```ts
interface TokenMeta {
  feedToken: string;
  filter: ContentFilter;   // 'members' | 'actionable' | 'length' — required
  authors: string[];       // lowercased; [] = no author restriction — required
  minLength: number;       // required; 0 = no minimum
}
```

All three (`filter`/`authors`/`minLength`) are required on every new
registration — there is no optional-with-fallback field left in this
schema. Pre-redesign KV entries that predate these fields (only
`feedToken`/old `level`) are legacy data: `runChannel` skips them from
bucketing (they get no alerts) until the device re-registers, which happens
automatically the next time the app is foregrounded (`FeedContext.tsx`
re-registers once per session). No migration write is needed — stale
entries simply age out via normal app usage.

## Local notifications are removed, not just superseded

This is not deferred cleanup — it ships in the same change. Once server
push covers arbitrary per-device filters, `notificationService.ts`'s local
scheduling pipeline is permanently dead: `wouldServerPush()` would predict
server coverage for every item local could ever fire on.

**No UX change other than removing local alerts themselves** — badges (tab
badges and the OS app-icon badge) keep behaving exactly as they do today,
including while the app is backgrounded or closed.

Removed entirely:

- `services/notificationService.ts` — the scheduling pipeline
  (`processNewItemsForNotifications`, `wouldServerPush`, `passes`,
  `isTopicMuted`, seen-id dedup tracking) and its test file.
- The "enable local notifications" toggle and section in Settings — "off"
  is just "unregistered," same as Members Area above.

**Not removed:** `backgroundFetchService.ts`, and the
`expo-background-task`/`expo-task-manager` wiring backing it, stay. Its
task callback bundles two unrelated things — firing local notifications
(dead, removed) and computing/caching unread counts so tab and app-icon
badges are accurate on next launch even after the app's been closed for a
while (not dead, unrelated to alerting, keeps behaving exactly as today).
Only the `processNewItemsForNotifications(...)` call inside that task comes
out; the badge-caching block stays untouched.

Consolidated, not orphaned: `authorFilters`/`minContentLength` (the values a
user was tuning for the now-dead local pipeline) become the
`authors`/`minLength` synced to the server — folded into `pushService.ts`
directly rather than left behind in a file that no longer does anything
else. The existing Settings UI fields (author whitelist, min-length slider)
are reused as-is; they now drive server registration instead of local
scheduling.

**Known, accepted gap:** per-topic muting (`subscriptionService`, the
"Silenced Topics" list in Settings) has never applied to server push — it
was always a local-only concept, and remains one. This isn't a regression
introduced here, and is explicitly out of scope for this change. Worth a
future issue if per-topic suppression is ever wanted server-side.

## Not yet done

- Worker: `ContentFilter`/`minVisibleTier`/`authorMatches`/`matchesFilter`
  in `@li/core` — done.
- Worker: strip topic-discovery/sub-feed-fetching out of `runChannel`
  entirely; per-forum-feed-only alerting with early-exit on first-seen guid.
- Worker: `TokenMeta`/`registerDevice`/`/register` endpoint — required
  fields, no fallback.
- Worker: bucket registered devices by `filter|authors|minLength` signature
  so devices sharing an identical configuration are classified once, not
  once per device (still worth doing even without topic tracking — it's a
  send-time and classification-time optimization, not a topic-tracking one).
- Worker: expose `isFirstPost` (or similar) on `RssItem` at parse time — the
  raw title's "Reply To: " prefix is currently discarded before any
  consumer sees it (`stripReplyPrefix` runs unconditionally in
  `extractRssItems`). Not consumed anywhere yet; this only unblocks a
  possible future "new topic" alert tier (a genuine first post has no
  "Reply To: " prefix on its raw title) — not building that tier now, just
  not losing the signal a second time.
- App: `pushService.ts` — fold `authors`/`minLength` in alongside `filter`,
  sync all three to `/register`.
- App: Settings UI — three-tier button row, reused author/length fields,
  drop the local-notifications section and its "enable" toggle.
- Delete `notificationService.ts` and its test file; trim the dead call out
  of `backgroundFetchService.ts`'s task callback (see above — the rest of
  that file stays).
- Tests, both Worker and app side.

## Deferred (filed separately, not part of this change)

- KV write-budget headroom (cron polling interval tuning, or reducing
  writes per poll) — see issue #32 (comment), plus a possible pre-deploy
  budget-check test. Real production data confirms all three channels are
  active and polling; the topic-tracking removal above independently
  improves this (one fewer unconditional write per poll) but doesn't fully
  resolve it.
- Issue #56: `FeedContext.tsx` double-registers the `members` channel (once
  for `membersArea`, once for `membersForum`) — should dedupe by resolved
  channel, not by feed key.
- CPU-time-limit exceptions observed on the Free plan — largely explained
  by the now-removed topic-sub-feed parsing volume; worth a follow-up check
  after this ships to confirm it's actually resolved before investigating
  further.
