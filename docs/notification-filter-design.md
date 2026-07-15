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

Three tiers, narrow to broad, each a strict superset of the previous:

```
members → actionable → length
```

- `members`: Members Area posts — unconditional (see below).
- `actionable`: keyword pattern match (buy/sell/tranche/urgency phrases);
  Stock/Options Insights additionally require a `*`-prefixed title.
- `length`: at least `minLength` characters, matched or not.

`filter: 'length', minLength: 0` covers "everything" — no separate `any`
value exists.

## Members Area is unconditional

`matchesFilter` returns `true` for Members Area regardless of a device's
author list or tier — a narrow `authors` whitelist (e.g. `['herman']`) never
silences it. The only way to stop Members Area alerts is to unregister the
device (`/unregister`); there is no separate "off" setting.

## `minVisibleTier`

```
minVisibleTier(item, minLength, actionableAuthors):
  if feedKey === membersArea: return 0
  isActionableAuthor = item.author in actionableAuthors
  topicPass = (stock/options) ? title.startsWith('*') : true
  actionable = isActionableAuthor && topicPass && !negativePatternMatch && positivePatternMatch
  if actionable: return 1
  return (length >= minLength) ? 2 : Infinity
```

`actionableAuthors` is who can trigger the `actionable` tier at all — a
pattern match from anyone else (e.g. a reply repeating or joking about
Sean's language) isn't a real trade call. It's a parameter, not a hardcoded
constant: the Worker reads it from `env.ACTIONABLE_AUTHORS` (comma-separated,
default `"Sean Hyman"`, same pattern as its other tunables) and passes it
into `matchesFilter`/`minVisibleTier`. It's shared by every device, not a
per-device value — independent of a device's own `authors` whitelist, which
`matchesFilter` applies separately on top of every tier: a Sean actionable
post still needs to pass a device's whitelist like anything else, and a
non-Sean post that a device does want to hear from can still surface at
`length` if it's long enough — it just never reaches `actionable`.

A negative-pattern match disqualifies `actionable` only — a long-enough
negative-pattern post still surfaces at `length`. `Infinity` means "not
visible at any tier, at this device's minLength"; it's parameterized per
device, not a fixed veto on the content.

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
