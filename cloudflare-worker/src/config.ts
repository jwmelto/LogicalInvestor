import { FeedKeys, type Channel, type FeedKey } from '@li/core';

// Split out of index.ts. workerd requires every named export of a Worker's entry module to be a
// function or a WorkerEntrypoint class. wrangler.toml's `main` field points at that entry module.
// A plain constant or object export fails at startup: "Incorrect type for map entry '<name>': the
// provided value is not of type 'function or ExportedHandler'."
//
// index.ts's exported functions (registerDevice, channelFromCron, etc.) are unaffected. Only
// these two non-function values needed to move.

// The app re-registers every push channel unconditionally on every cold launch (FeedContext), so
// a registration that stops renewing means the device is gone (uninstalled, or never called
// /unregister). This TTL just needs slack beyond normal usage gaps — weeks, not days — see #60.
//
// Distinct from, and not made redundant by, the per-registration access revalidation in
// index.ts (issue #86): revalidation answers "is this feedToken's WordPress subscription still
// valid," and deletes fast once it's confirmed not to be. This TTL answers a question
// revalidation can never answer — "is any device still actually here to receive pushes at all" —
// since a token can keep passing feedTokenHasAccess indefinitely even after its owner uninstalled
// the app or a browser silently dropped the subscription. Revalidation's successful path
// deliberately preserves this TTL rather than resetting it on every check, specifically so a
// long-abandoned-but-still-access-valid registration still expires on schedule instead of being
// kept alive forever by revalidation alone.
export const DEFAULT_TOKENS_TTL_DAYS = 30;

// The 'members' Channel bundles two distinct feeds under one push-registration grouping.
// feedTokenHasAccess() in index.ts always checks index [0] of a channel's feed list, so order is
// deliberate here: Members Forum is first because its feed requires a valid feed_token to
// return any items, making it a real check of membership status (catches an expired or
// invalid token). Members Area's feed is readable regardless of token validity — only the
// content snippet is paywalled — so it would never catch anything if checked instead.
//
// No `discoverTopics`/topic-sub-feed fetching here — the top-level "All Posts" feed for a forum
// already aggregates replies from every topic in it (confirmed against a real authenticated
// fetch), so alerting never needs to walk into individual topics. Topic discovery remains a
// purely app-side concern (topicService.ts) for the browsing UI.
export const CHANNEL_FEEDS: Record<Channel, { url: string; feedKey: FeedKey }[]> = {
  members: [
    { url: 'https://logicalinvestor.net/forums/forum/members-forum/feed/', feedKey: FeedKeys.membersForum },
    { url: 'https://logicalinvestor.net/feed/',                            feedKey: FeedKeys.membersArea },
  ],
  stock: [
    { url: 'https://logicalinvestor.net/forums/forum/stock-insights/feed/', feedKey: FeedKeys.stockInsights },
  ],
  options: [
    { url: 'https://logicalinvestor.net/forums/forum/options-insights/feed/', feedKey: FeedKeys.optionsInsights },
  ],
};
