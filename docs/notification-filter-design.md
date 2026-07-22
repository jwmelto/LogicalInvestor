# Notification filter redesign

Per-device notification filtering for the `cloudflare-worker` push backend,
replacing the single global `AUTHOR_FILTER` var applied identically to every
device. Implemented on `feature/notification-filter-redesign`.

## Server-side alerting

Per forum, per cron tick:

```
fetch the forum's RSS feed → up to N items (configurable), reverse-chronological
walk newest-to-oldest, collecting unseen items, until the first already-seen guid
reverse the collected items to oldest-first
for each item, for each device registered to this channel:
  matchesFilter(item, device.filter, device.authors, device.minLength)
```

The forum's top-level feed (bbPress's "All Posts" feed) already contains
every reply in that forum, not just new-topic creation — confirmed against a
real authenticated fetch (25/25 sampled items were replies, spanning 8+
topics, strictly reverse-chronological by `pubDate`). So alerting reads only
the flat per-forum feed; topic discovery and per-topic sub-feeds
(`topicService.ts`) are an app-only concern for the browsing UI.

Complexity: O(items × registered devices) per forum per poll. Items are
capped per poll (`MAX_ALERT_ITEMS_PER_FEED`, configurable); `matchesFilter`
is a handful of regex/string checks, so linear scaling in device count is
fine at current and foreseeable scale.

The app does its own full reconciliation (complete topic history, unread
tracking, hierarchical browsing) on every foreground refresh, independent of
the server. The server's per-poll item cap bounds what's timely enough to
alert on — it is not a completeness guarantee.

## Filter tiers

Each tier matches everything the tier before it does, plus one more thing:

- **`members`** matches all Members Area posts. Nothing else.
- **`actionable`** matches all Members Area posts, plus posts by
  `actionableAuthors` (shared server config, `env.ACTIONABLE_AUTHORS`) that
  pass the actionable-signal pattern check — for Stock/Options Insights,
  also requiring a `*`-prefixed title.
- **`length`** matches everything `actionable` matches, plus any post at
  least `minLength` characters long from an author on the device's own
  `authors` whitelist.

`filter: 'length', minLength: 0` covers "everything" — no separate `any`
tier exists.

Two rules protect that cumulative structure, both enforced in
`matchesFilter`/`TIER_MATCHERS` (`packages/core/src/index.ts`, one matcher
function per `ContentFilter` — the same pattern `FEEDS[k].isVisible()` uses
per feed):

- **Members Area is unconditional.** The check runs before any tier logic
  at all — no device whitelist, author, or content check can silence it,
  regardless of tier. The only way to stop Members Area alerts is
  unregistering the device (`/unregister`).
- **The device's own `authors` whitelist gates only `length`'s own added
  clause, never the `actionable` posts it inherits.** If the whitelist also
  gated the inherited half, `length` could reject a post `actionable` alone
  would have allowed — the opposite of "matches everything actionable
  matches, plus more."

A negative-pattern match disqualifies `actionable` only; the same post can
still surface at `length` via the plain length check.

## Author matching

`authors: string[]`, lowercased, stored per device at registration. Empty
list = no author restriction. There is no global fallback for this value —
`filter`, `authors`, and `minLength` are required on every registration.
(Separate from `actionableAuthors` above, which is shared Worker
configuration gating the `actionable` tier itself, not any one device's
preferences.)

## `TokenMeta`

```ts
interface TokenMeta {
  feedToken: string;
  filter: ContentFilter;   // 'members' | 'actionable' | 'length'
  authors: string[];       // lowercased; [] = no author restriction
  minLength: number;       // 0 = no minimum
}
```

All three are required on every new registration. Any KV entry missing them
is excluded from bucketing (gets no alerts) until the device re-registers,
which happens automatically the next time the app is foregrounded
(`FeedContext.tsx` re-registers once per session). No migration is needed —
stale entries age out via normal app usage.

## Local notifications

`services/notificationService.ts` (the scheduling pipeline and its test)
is deleted. `backgroundFetchService.ts` keeps its unread-count/badge-caching
logic — only the dead notification call inside its task callback is
removed; tab and app-icon badges behave exactly as before, including while
the app is backgrounded or closed.

`authorFilters`/`minContentLength` (the local-pipeline settings) are now
`authors`/`minLength` in `pushService.ts`, synced to `/register`. The
existing Settings UI fields (author whitelist, min-length slider) drive
server registration directly.

Per-topic muting (`subscriptionService`, the "Silenced Topics" list) has
never applied to server push — it's a local-only concept and remains one.

## Filed separately

- Issue #32: KV write-budget headroom (cron polling interval tuning, or
  reducing writes per poll).
- Issue #56: `FeedContext.tsx` double-registers the `members` channel (once
  for `membersArea`, once for `membersForum`) — should dedupe by resolved
  channel, not by feed key.
- Issue #58: Members Area returning items regardless of token validity can
  mask a stale token for the `members` channel specifically.
