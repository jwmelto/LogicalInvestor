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
the flat per-forum feed; there's no need to discover or fetch individual
topics.

Complexity: O(items × registered devices) per forum per poll. Items are
capped per poll (`MAX_ALERT_ITEMS_PER_FEED`, configurable); `matchesFilter`
is a handful of regex/string checks, so linear scaling in device count is
fine at current and foreseeable scale.

The per-poll item cap is the only view of feed history the system has —
there's no separate reconciliation pass anywhere. Content already past the
cap the first time it's observed is never alerted on.

## Filter tiers

Three tiers, narrow to broad: `members`, `actionable`, `length`. Each
matches everything the tier before it does, plus one more thing.

`members` matches all Members Area posts. Nothing else.
Unregistering the device (`/unregister`) is the only way to stop Members Area alerts.

`actionable` matches all Members Area posts. It also matches a post that
meets every one of these conditions:

1. The author is in `actionableAuthors` — shared server config,
   `env.ACTIONABLE_AUTHORS`.
2. The content matches an actionable pattern: buy, sell, tranche, or
   urgency phrasing.
3. The content does not match a negative pattern: hedging, personal
   opinion, or a historical reference.
4. For Stock/Options Insights posts, the title starts with `*`.

`length` matches everything `actionable` matches. It also matches any post
that is at least `minLength` characters long and whose author is on the
device's own `authors` whitelist.

## Author matching

The Worker trims and lowercases each author when the device registers.
A whitelist entry matches when the post's author contains it as a substring, not an exact match or regex.
An empty whitelist is a wildcard — it matches every author.

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
is excluded from bucketing (gets no alerts) until the registration is
resubmitted — there's no automatic re-registration trigger, so a stale entry
stays excluded until whoever registered it opens `web-push/` and submits the
form again.

## Filed separately

- Issue #32: KV write-budget headroom (cron polling interval tuning, or
  reducing writes per poll).
- Issue #58: Members Area returning items regardless of token validity can
  mask a stale token for the `members` channel specifically.
