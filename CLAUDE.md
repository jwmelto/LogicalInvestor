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

The Bash tool shell state persists across calls. A bare `cd` leaves the working directory wrong for subsequent calls.

## Project Overview

LogicalInvestor is a React Native (Expo) iOS/Android app that serves as a full replacement for visiting logicalinvestor.net. It reads paywalled WordPress/bbPress forum content using a per-user feed token for authentication. The app is intended to be distributed to other subscribers of the site.

The app requires authentication via WordPress login, stores credentials securely, and syncs data across devices (iCloud on iOS, AsyncStorage on other platforms).

## Development Environment

**Project path:** `~/development/LogicalInvestor`  
**Bundle ID:** `space.melton.logicalinvestor`  
**Git branch:** `main`

### Critical Toolchain

- **Xcode:** Required. Command line tools must be installed separately.
- **Node:** Node 24 LTS via fnm (Fast Node Manager), **NOT system Node**
- **CocoaPods:** Installed via Homebrew, not Gem

### Setup Instructions

**See SETUP.md for complete, step-by-step setup instructions** including:
- Xcode and command line tools installation
- fnm and Node 24 setup
- CocoaPods installation
- iOS simulator configuration
- Full end-to-end verification

Quick reference:
```bash
# Key setup commands
brew install fnm
fnm install 24
brew install cocoapods
npm install
npx expo prebuild --platform ios
npm start           # Start Metro bundler
npm run ios         # Build and run on iOS simulator
```

**Important:** fnm eval must be **LAST** in `~/.zshrc` (after all Homebrew setup)

## Development Workflow

Use feature branches for all work (e.g., `feature/push-notifications`). Merge to `main` when complete. This keeps history clean and provides safe rollback.

Track planned work, bugs, and open questions as GitHub Issues — not in this file. A roadmap list here goes stale the moment work lands and nobody remembers to edit it back out.

## Tech Stack

- **Framework**: Expo 54 (React Native) with New Architecture enabled
- **Language**: TypeScript with strict mode
- **Navigation**: Expo Router SDK 53 (file-based routing) + React Navigation
- **React Version**: 19.1.0 (with React Compiler enabled)
- **Storage**: 
  - `expo-secure-store` (tokens, device keychain)
  - `@nauverse/expo-cloud-settings` (iCloud KVS sync on iOS)
  - `@react-native-async-storage/async-storage` (fallback for non-iOS)
- **Data Parsing**: `fast-xml-parser` (RSS/XML feeds)
- **Post Links**: Opened via `Linking.openURL()` in the system default browser, with `feed_token` appended manually (RSS `<link>` values never carry it) — `react-native-webview` remains an installed dependency but has no current usage in app code
- **UI Components**: Native React Native components with custom theming
- **Background Tasks**: `expo-background-task` + `expo-task-manager`

## Commands

### Development
```bash
npm start           # Start development server (press 'i' for iOS, 'a' for Android, 'w' for web)
npm run ios         # Run on iOS simulator
npm run android     # Run on Android emulator
npm run web         # Run web version
npm run lint        # Run ESLint
```

### Project Setup
```bash
npm install                        # Install dependencies
npx expo prebuild --platform ios   # Generate /ios directory, install CocoaPods
npm run reset-project              # Reset to blank project (moves starter code to app-example/)
```

### App Store Distribution (EAS Build)
For creating production-ready builds to submit to the App Store or TestFlight:
```bash
npm install -g eas-cli             # Install globally (one-time)
eas login                          # Authenticate with Expo account
eas build:configure                # Configure project for EAS (one-time)
npm run eas-build                  # Production builds, both platforms (see below)
```

**Use `npm run eas-build`** (`scripts/eas-build.sh`) rather than calling `eas build` directly — it submits iOS first (typically serviced faster in the queue), then Android, both with `--no-wait` so they queue concurrently instead of Android waiting for iOS to finish (`eas build`'s `wait` flag defaults to `true`), and exports two env vars that suppress benign warnings before each call:
- `EAS_BUILD_NO_EXPO_GO_WARNING` — dev workflow uses `expo prebuild` + native builds, not the Expo Go app, so EAS's "you're using Expo Go" detection is a false positive here
- `EAS_BUILD_SKIP_LOCKFILE_CHECK` — `package-lock.json` is intentionally gitignored, so EAS's local check for its presence always fails

Both checks read `process.env` directly inside `eas-cli`'s local pre-flight step, before the project is packaged and uploaded — `eas.json`'s per-profile `env` block only reaches the *remote* build container, so it can't suppress either one. They have to be real shell env vars at invocation time, which is what the script does.

Both calls also pass `--non-interactive`, which skips the "Do you want to log in to your Apple account?" prompt. This is safe here specifically because an App Store Connect API Key is already registered for this app on Expo's servers (visible at expo.dev → project → Credentials → iOS → Service credentials → "App Store Connect API key") — under `--non-interactive`, `eas-cli` automatically discovers and authenticates with that key instead of a user session (`tryAuthenticateAppStoreWithEasAscApiKeyAsync` in its source). Verified against a real run: it logs `Using App Store Connect API Key from EAS credentials service` and actually fetches/validates the provisioning profile against Apple's servers — not a silent no-op. One caveat observed in that same run: the distribution certificate specifically is *not* re-validated against Apple in non-interactive mode (`Distribution Certificate is not validated for non-interactive builds` — eas-cli trusts the already-stored cert metadata rather than checking it live); only the provisioning profile gets the live check. Without a registered ASC API Key at all, `--non-interactive` would skip authentication entirely and fall back to trusting locally-cached state for everything — worth knowing if this ever moves to a different Expo account/project that hasn't set one up.

**Notes:**
- Local development continues via `npm run ios` (faster iteration)
- EAS Build handles app signing, provisioning profiles, and certificates securely
- Requires Apple Developer Program membership ($99/year) to submit to App Store
- Free Expo account supported; paid plans offer priority build queue
- See [Expo EAS Build docs](https://docs.expo.dev/build/setup/) for details

## Architecture

### Core Principle

No backend. The app talks directly to logicalinvestor.net. Everything is token-authenticated via a per-user feed token appended as `?feed_token=<token>` to all URLs (feeds AND page loads).

### Routing & Navigation

**File**: `app/_layout.tsx` (root layout)

The app uses a protected routing pattern:
- **Authentication Guard**: Routes protected via `<Stack.Protected guard={authed}>`
- Unauthenticated users see `login` screen
- Authenticated users see `(tabs)` layout with per-forum tabs and Settings
- Uses `useColorScheme()` hook to apply theme (light/dark) via React Navigation's `ThemeProvider`

**Important**: Do NOT use `router.replace()` from `_layout.tsx` — it causes remounting loops. Use `Stack.Protected` pattern (Expo Router SDK 53+).

### Services Layer

**Location**: `services/` directory

#### `authService.ts` - Authentication

**Login Flow**:
1. Fetch login page to get cookies/nonce
2. POST credentials to `https://logicalinvestor.net/backend/` with Fusion login form
3. Check final redirect URL — success if does NOT contain `"member-login"`
4. Fetch `https://logicalinvestor.net/my-feed-url` using auth cookies
5. Extract feed token via regex: `feed_token=([a-zA-Z0-9_-]+)`
6. Store token in `expo-secure-store` (device keychain, encrypted)
7. Token persists across app restarts; re-auth only needed if token revoked

**Login POST details** (exact field names required):
```
URL: https://logicalinvestor.net/backend/
Fields:
  log               = username
  pwd               = password
  wp-submit         = "Log in"           ← lowercase 'i', exact
  user-cookie       = "1"
  fusion_login_box  = "true"
  _wp_http_referer  = "/member-login/"
  redirect_to       = "https://logicalinvestor.net"
Headers:
  Referer: https://logicalinvestor.net/backend/
  redirect: 'manual'
```

**Key Functions**: `login()`, `getToken()`, `isAuthenticated()`, `logout()`

#### `feedService.ts` - Feed Aggregation

**Feed Sources** (defined in `FEEDS` constant):
```
Members Area:     https://logicalinvestor.net/feed/
Members Forum:    https://logicalinvestor.net/forums/forum/members-forum/feed/
Stock Insights:   https://logicalinvestor.net/forums/forum/stock-insights/feed/
Options Insights: https://logicalinvestor.net/forums/forum/options-insights/feed/
```

All require `?feed_token=<token>` appended. Stock Insights and Options Insights are optional paid subscriptions — they return 0 items if the user lacks access. This is correct behavior, not a bug.

Each entry in `FEEDS` includes a `hasSubFeeds` boolean. Feeds with `hasSubFeeds: true` trigger topic discovery via `topicService`.

Each entry also owns its own `isVisible(visibility: ForumVisibility): boolean` method — Members Area/Members Forum always return `true`; Stock/Options Insights defer to the user's stored Settings toggle. A feed answers its own visibility question directly rather than a shared function special-casing every key by name.

**Topic Sub-feeds**: For a topic URL like `https://logicalinvestor.net/forums/topic/nvo/`, the sub-feed is `https://logicalinvestor.net/forums/topic/nvo/feed/`. Derived dynamically in `fetchTopicFeed()` — no hardcoding needed.

**Parsing**: Uses `fast-xml-parser` with config:
```typescript
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});
```
Parse path: `parsed?.rss?.channel?.item`. Handle both single items and arrays (wrap single item in array).

**Error Handling**: The `response.status === 401/403 → accessible: false` branch in `fetchSingleFeed()` is defensive code, not the real mechanism — verified against the live server, all four feed URLs return HTTP 200 regardless of token validity (invalid/missing `feed_token` never triggers a 401/403 on this WordPress install). The actual signal for "no access" is **zero items returned**: Members Forum, Stock Insights, and Options Insights all return `<item>`-less RSS with a bad or missing token. Members Area is the exception — it always returns items (only the content snippet is paywalled) — so it's structurally incapable of signaling a dead token; this is also why Stock/Options Insights returning 0 items is treated as "not subscribed" rather than an error (see below). Non-200 responses (network errors, 5xx) still return `accessible: true` with an optional `error` message.

**Key Functions**: `fetchAllFeeds()`, `fetchSingleFeed()`, `fetchTopicFeed()`  
**Return Shape**: `FeedResult` with items array, accessibility flag, optional error

**Note on REST API**: bbPress intentionally does not set `show_in_rest: true`. REST API is useless for forum topic discovery.

#### `storageService.ts` - Cross-Platform Storage

Two-tier storage abstraction (app code never touches storage directly):
- **iOS with iCloud signed in**: `@nauverse/expo-cloud-settings` (NSUbiquitousKeyValueStore, auto-syncs across user's Apple devices)
- **iOS without iCloud / Android**: `@react-native-async-storage/async-storage` (local only)

**Dual API**:
- String storage: `storageGet(key)`, `storageSet(key, value)`
- JSON object storage: `storageGetObject<T>(key)`, `storageSetObject<T>(key, value)`

**Critical**: iCloud KVS is NOT encrypted. Do not store feed token there. Token stays in `expo-secure-store`. Topic preferences and read state are safe in iCloud KVS.

**iCloud Setup**: Requires a paid Apple Developer account — active as of the account used for this project. `"@nauverse/expo-cloud-settings"` is in the `plugins` array in `app.json` and `useICloud = Platform.OS === 'ios'` in `storageService.ts` — no conditional setup remaining.

Full iCloud sync requires a physical device; Simulator uses AsyncStorage fallback silently.

**iCloud verification checklist** (run on physical device with iCloud signed in):
- [ ] Install app on two devices under the same Apple ID
- [ ] Log in on device A; confirm topics and read state appear on device B after a few seconds
- [ ] Mark posts read on device A; confirm unread counts update on device B
- [ ] Toggle a forum off in Settings on device A; confirm it's hidden on device B
- [ ] Confirm feed token is NOT synced (log out on device B and re-login independently)

**iCloud strategy**: iCloud KVS is the right cross-platform approach for this app. No backend is a core principle, and iCloud KVS provides free cross-device sync on iOS with a transparent AsyncStorage fallback on Android. The library's TypeScript types lag behind its API in one place (`getObject` is not typed as generic); work around with a cast at the callsite rather than changing the approach.

#### `readStateService.ts` - Unified Read/Unread Tracking

Single store, `scope_guids` (`Record<scopeId, Record<guid, boolean>>`), answers both "is this guid known" (key present) and "is this guid read" (boolean value) for every feed and every topic. `scopeId` is either a `FeedKey` (the flat Members Area feed) or a topic id (`"{forumKey}:{slug}"`, see `topicService.ts`) — the two namespaces never collide, since a topic id always contains `:` and a feed key never does. There is no separate "unread count" anywhere — every consumer only ever needs `hasUnread: boolean`.

**Mutation is always multi-scope and batched**: `markScopesSeen(updates)` inserts newly-seen guids as unread (never resurrecting an already-read guid that resurfaces in a refetch); `markGuidsRead(updates)` flips guids to read. Both take `Record<scopeId, guid[]>` so "mark this whole forum read" (spanning several topics) is one read-modify-write, not one per topic — concurrent individual writes to the same storage key race and overwrite each other. `markRead(scopeId, guid)`/`markAllRead(scopeId, guids)` are single-scope convenience wrappers over `markGuidsRead`, fine for one-off calls but never to be called in a loop over many items — batch-load `getAllScopes()` once and use `viewScope()` instead (see `detectForumUnread`'s implementation for the pattern; calling the single-scope wrappers per item was a real, since-fixed inefficiency).

**`viewScope(guids)`**: a pure, synchronous, read-only view (`{ hasUnread, isRead(guid) }`) over an already-loaded scope. No I/O, no stored mutable state — two independently-loaded views of the same scope each mutating and saving on their own would race, so all mutation goes through the batch functions above.

**`detectForumUnread(forumKey, topLevelItems)`**: the per-topic detection algorithm. Relies on a completeness proof rather than a schedule — the bbPress RSS feed reliably returns items newest-first. Walking newest→oldest, skipping silenced topics entirely: if the newest considered item is already known, nothing changed; if a known item is hit before the window is exhausted, everything before it is provably the complete set of new posts (attributed via `extractTopicSlugFromLink`, never by title); if the whole window is exhausted with nothing known, a bounded deep-dive of the 10 most-recently-active *subscribed* topics runs instead of every topic. Returns `hasUnread` for every topic touched this pass; an untouched topic provably didn't change.

**`markFlatFeedSeen(feedKey, items)`**: the flat-feed equivalent — no boundary-walk needed, since there's no per-item fetch cost to save, so every fetch just records its whole window as seen.

**`topicUnreadForForum(forumKey, scopes, subs)`**: a pure, synchronous helper deriving every subscribed topic's `hasUnread` for a forum directly from an already-loaded `scopes`/`subs` snapshot — no I/O, no topic-registry read. Which topics belong to a forum is derived from scanning `scopes`' own keys for the `"{forumKey}:"` prefix, not a separate `getTopicsForForum()` lookup. Shared by both `FeedContext.tsx`'s cold-start seed and `app/(tabs)/index.tsx`'s landing-tab decision, so the same derivation isn't duplicated across the two.

**Key Functions**: `hasUnread()`, `isRead()`, `markRead()`, `markAllRead()`, `markScopesSeen()`, `markGuidsRead()`, `markFlatFeedSeen()`, `detectForumUnread()`, `topicUnreadForForum()`, `viewScope()`, `getAllScopes()`

#### `subscriptionService.ts` - Topic Subscriptions

Per-topic boolean subscriptions, default `true` for unseen topics. Unsubscribed topics hidden from feed view. **LOCAL ONLY** — does not interact with site's email subscription system.

#### `topicService.ts` - Topic Discovery

Discovers forum topics from RSS feed items, persists them across sessions. Topics are sorted by `lastUpdatedAt` so active discussions float to the top.

**Identity is slug-based, not title-based**: `generateTopicId(forumKey, slug)` builds a topic's id from its (mostly immutable) URL slug, not its title — a moderator editing a title, or an unrelated new topic reusing an old one, would otherwise break identity. `discoverTopicsFromFeedItems` groups by slug; `name` (display) still comes from whichever item's title first created the record.

**Key Functions**: `updateTopicsFromFeedItems()`, `getTopicsForForum()`, `generateTopicId()`, `generateTopicUrl()`, `extractTopicSlugFromLink()`

#### `backgroundFetchService.ts` - Background Refresh

Registers an `expo-background-task` task that fetches all feeds while the app is closed, then writes straight into the same `scope_guids` store `readStateService.ts` owns (`markFlatFeedSeen` for the flat feed, `detectForumUnread` per topic-based forum) — there's no separate cached badge snapshot; the next foreground open's cold-start seed (`FeedContext.tsx`) reads `scope_guids` directly. This task is a best-effort supplement only, not load-bearing — `expo-background-task`'s 15-minute minimum is non-deterministic on iOS, and the primary detection trigger is `FeedContext.tsx`'s foreground refresh cycle.

Skips detection entirely for a forum currently hidden in Settings (`FEEDS[k].isVisible(visibility)`) — no point spending a bounded per-topic deep-dive fetch on a badge nobody can see. The top-level fetch itself still runs for every feed regardless, so a re-enabled forum's data isn't stale.

**Note**: Background tasks only run on physical devices. Simulator always uses AsyncStorage fallback and background tasks do not fire.

#### `notificationService.ts` - Local Notifications

> **Stale section** — this file was deleted in commit `56abc3d`; local notification generation no longer exists client-side. All "which posts to alert on" logic now lives server-side in the Cloudflare Worker (the "Filter sync with Cloudflare Worker" and Worker-behavior details below describe the Worker side and may still be accurate, but everything above them describing app-side `notificationService.ts` behavior is not). Needs a follow-up doc pass — not corrected here.

Filters incoming feed items and schedules local notifications via `expo-notifications`.

**Settings** (`NotificationSettings`): `enabled`, `authorFilters` (string whitelist, substring match), `minContentLength` (stripped HTML char count, default 200).

**Key logic**:
- First run: seeds all current item IDs as "seen" without notifying (flood prevention)
- Subsequent runs: notifies only for truly new items that pass filters, max 5 per cycle
- Notification title format: `"[LOCAL] Sean Hyman in EWZ:"` (strips `Reply To:` prefix). The `[LOCAL]`/`[PUSH]` tag lets delivery-channel dedup (below) be visually verified on a real device
- Local notification is skipped whenever `wouldServerPush()` predicts the Worker's server push already covers that item — one alert per item, not two, on either platform
- `fireTestNotification()` bypasses seen-ID tracking for dev testing (`__DEV__` gated button in Settings)
- `addNotificationAuthor(name)` — called from long-press gesture in ForumFeed

**Storage keys**: `notification_settings`, `notification_seen_ids`

**Filter sync with Cloudflare Worker**: The app's local notification filters (`authorFilters`, `minContentLength`) and the Worker's server-side filters are **independent and not synchronized**. Both must be kept in sync manually when filter logic changes:
- App filters live in `notificationService.ts` (`processNewItemsForNotifications`)
- Worker filters live in `cloudflare-worker/src/index.ts` (the cron handler)
- The Worker suppresses pushes for items the app's local filter would catch anyway; if the Worker's filters are looser than the app's, users may receive push notifications for items that would have been silenced locally
- Current Worker behavior, by notification level (`none`/`minimal`/`standard`/`all`, set per-device at registration via `pushService.ts`):
  - `none`: nothing notifies, not even Members Area
  - `minimal`: only Members Area notifies
  - `standard`: Members Area always notifies; Members Forum/Stock/Options Insights require author = Sean Hyman, AND (for Stock/Options Insights only) topic title contains `*`, AND the content passes the actionable-signal check — a starred topic does not exempt low-signal replies like "good job" from that last check
  - `all`: Members Area always notifies; other forums require author = Sean Hyman but skip the star/actionable checks entirely
- `/register` requires `feed_token` on every call, for every channel — `pushService.ts`'s `registerPushChannel()` and `updatePushLevel()` both always send it. Every channel verifies it via `feedTokenHasAccess` and stores it as `poll:<channel>`, the token `runChannel()` polls that channel's content with. The `members` **channel** (the push-registration grouping that bundles both Members Area and Members Forum — see `CHANNEL_FEEDS`) checks access against Members Forum specifically, since Members Area's own feed is readable regardless of token validity and would never catch an expired or invalid one.

**Checking Worker status**: `GET /status` requires the Worker's `FEED_TOKEN` secret as a Bearer header — not a query param, so it can't be checked by pasting a URL into a browser (no `WWW-Authenticate` challenge is sent, so browsers won't prompt for credentials either). Use curl:
```bash
curl -H "Authorization: Bearer $FEED_TOKEN" https://logicalinvestor-push.logicalinvestor.workers.dev/status
```
The Worker already pretty-prints the JSON response, so no `jq` needed. `FEED_TOKEN` is the same secret set via `wrangler secret put FEED_TOKEN` — not stored in any file in this repo.

**Cron dead-man's-switch monitoring**: `/status` only tells you what happened on the last successful run — it can't tell you if runs have silently stopped happening. On 2026-07-01/02 all three Cron Triggers (`members`/`stock`/`options`) stopped dispatching to `scheduled()` for ~15h with nothing anywhere surfacing an error (root cause: a stuck Cloudflare Cron Trigger registration, not application code; see issue #24). To catch this class of failure:
- Each channel's cron pings its own healthchecks.io check (`HEARTBEAT_URL_MEMBERS` / `HEARTBEAT_URL_STOCK` / `HEARTBEAT_URL_OPTIONS`, Worker secrets) at the top of `scheduled()`, fire-and-forget via `ctx.waitUntil(...).catch(() => {})` — a hung or failing ping can't block the actual channel poll
- One check per channel, not one shared check: each cron entry in `wrangler.toml` is an independent Cloudflare Cron Trigger registration and can get stuck without the others being affected
- healthchecks.io checks are configured as **Simple** schedule (not Cron) — period 5 min, grace 15 min — matching how often each channel's cron actually fires; alerts by default go to the account email
- `heartbeatUrlFor(channel, env)` in `cloudflare-worker/src/index.ts` does the channel → secret lookup

### Contexts

**Location**: `contexts/` directory

#### `FeedContext.tsx` - Unread Badge State + Refresh Timer

Central store for per-feed `hasUnread` booleans (`unread`) and per-topic booleans (`topicUnread`) that drive tab bar badges. Also owns the foreground refresh timer and orchestrates unread detection.

**Badges**: On mount, a cold-start seed effect computes every badge — flat feed and every subscribed topic in every forum — directly from the local `scope_guids` store (`readStateService.ts`), with zero network calls, before the first fetch even lands. After each fetch, the flat feed calls `markFlatFeedSeen` + `hasUnread`; each topic-based forum calls `detectForumUnread` and merges the result into `topicUnread`. A forum's own badge is always the OR across its topics' flags, kept in sync by a dedicated effect. `refreshScopeUnread(feedKey, scopeId)` lets `ForumFeed` re-derive a single scope's badge immediately after marking something read, rather than waiting for the next fetch cycle.

Detection (`markFlatFeedSeen`/`detectForumUnread`) is skipped entirely for a forum currently hidden via Settings' visibility toggle (`FEEDS[k].isVisible(visibility)`) — the top-level fetch itself still runs for every feed regardless, so a re-enabled forum's data isn't stale, only its detection work was deferred while hidden.

**Foreground refresh timer**:
- Fires every N minutes (configured via `getRefreshInterval()`, default 30 min)
- Increments `refreshSignal`; all mounted `ForumFeed` components re-fetch when signal changes
- Pauses when app is backgrounded (no JS wakeups)
- On foreground return: resumes with remaining time if not yet due; fires after 1.5s delay if overdue (delay lets any in-flight `markRead` writes settle before re-fetching)
- Manual pull-to-refresh calls `notifyManualRefresh()` to reset the timer from zero

#### `ForumVisibilityContext.tsx` - Forum Tab Visibility

Persists which optional forum tabs (Stock Insights, Options Insights) are enabled. Drives `href: null` in the tab layout to hide disabled tabs entirely.

Since `FeedContext` skips detection work for a hidden forum, its badge would otherwise show stale state (whatever was last computed before it was hidden) for as long as it stays disabled. `app/(tabs)/settings.tsx`'s toggle handler calls `FeedContext`'s `triggerRefresh()` immediately whenever a forum is turned back **on** — turning one off doesn't refresh, since there's nothing new to compute for a forum about to stop being shown.

### UI Structure

**Tabs Layout**: `app/(tabs)/_layout.tsx`
- Per-forum tabs: Members Area, Members Forum, Stock Insights (optional), Options Insights (optional), Settings
- Tab badges: red dot shown when feed has unread items; 50% scaled via `tabBarBadgeStyle`
- Optional forums hidden (not grayed) via `href: null` when disabled in Settings

**Tab Screens**:
- `members-area.tsx`, `members-forum.tsx`, `stock-insights.tsx`, `options-insights.tsx` — thin wrappers that render `<ForumFeed feedKey="..." />`
- `settings.tsx` — logout, forum visibility toggles, refresh interval

**Additional Screens**:
- `login.tsx` — Authentication screen
- `modal.tsx` — Modal presentation

**`ForumFeed` component** (`components/ForumFeed.tsx`):
The core UI component. Handles flat feeds (Members Area) and topic-based feeds (forum tabs).
- Header row shows forum title + "Mark all read" button when unread items exist
- Flat feeds: individual `[new]` badges are tappable to mark that post read without opening it
- Topic feeds: hierarchical display (Topic → posts), tappable `[new]` badge per topic, topic preview snippet (latest post) shown only when that topic `hasUnread`
- Tapping a post calls `openPostLink()`, which appends `feed_token` to the item's raw RSS `<link>` (via `URL.searchParams.set()`) before opening it with `Linking.openURL()` — the system's default browser, not an in-app viewer
- Pull-to-refresh triggers `triggerRefresh()` on the context to reset the timer

### Theming

**File**: `constants/theme.ts`

- **Colors**: Separate light/dark palettes
  - Light: primary tint `#0a7ea4`
  - Dark: primary tint `#fff`
- **Fonts**: Platform-specific (system fonts on iOS, fallbacks on Android/web)
- Imported by root layout for React Navigation theme provider

### Custom Hooks

**Location**: `hooks/` directory

- `use-color-scheme.ts` / `use-color-scheme.web.ts` — Detects system dark/light mode preference (platform-specific)
- `use-theme-color.ts` — Applies theme colors based on color scheme
- `use-notification-permissions.ts` — Requests notification permissions on app launch

## Current Features & State

### Implemented
- ✅ WordPress authentication with secure token storage
- ✅ Multi-feed RSS aggregation (4 feeds: Members Area, Forum, Stock/Options Insights)
- ✅ Per-forum tabs; optional forums (Stock/Options Insights) can be hidden entirely via Settings
- ✅ Topic discovery & display: auto-discover forum topics from RSS, hierarchical UI (Forum → Topic → Posts), lazy-load topic feeds, per-topic subscription
- ✅ Topic UX: previews persist across refreshes, tappable `[new]` badge per topic, preview only shown when topic has unread posts
- ✅ Read state persistence with atomic batch writes (`markAllRead`)
- ✅ "Mark all read" button in every feed header (dismisses historical backlog on first use)
- ✅ Tappable `[new]` badges on individual flat-feed posts
- ✅ Tab bar red-dot badges (all tabs); seeded from storage on launch so unvisited tabs show correct state
- ✅ Foreground refresh timer (configurable interval, pauses when backgrounded, resumes correctly on return)
- ✅ Background fetch (physical device only) — keeps the shared `scope_guids` read-state store fresh as a best-effort supplement to the foreground detection cycle
- ✅ Pull-to-refresh resets the foreground timer
- ✅ Post links open in the system browser with `feed_token` appended
- ✅ Dark/light mode support
- ✅ Cross-platform (iOS with iCloud sync, Android, Web)
- ✅ Inaccessible feeds filtered out (Options Insights hidden if no access)
- ✅ Logout clears token and redirects to login
- ✅ iCloud/AsyncStorage storage abstraction; TypeScript strict mode clean (zero compiler errors)
- ✅ Local notifications triggered by background fetch — filtered by author whitelist + minimum content length
- ✅ Long-press any post/preview to add that author to notification whitelist
- ✅ Notification settings in Settings screen (collapsible section: enable toggle, min length slider, author whitelist list)
- ✅ Build number auto-increments via `eas.json`'s `autoIncrement: true` on the `production` profile — this patches the compiled native binary directly during the EAS build, not `app.json`; read it at runtime via `expo-application`'s `Application.nativeBuildVersion`, not `Constants.expoConfig`

### Known Issues

**Minor Issues**:
- 4 moderate npm vulnerabilities in toolchain (uuid, glob, rimraf, inflight) — Expo upstream, unfixable without breaking Expo
- `ld: ignoring duplicate libraries: '-lc++'` — Harmless Xcode 16 warning

**Behavior Notes**:
- Optional subscription feeds (Stock Insights, Options Insights) return 0 items if user lacks access — correct behavior, not a bug
- Background fetch does not run in simulator — requires physical device

## QA Checklist

Run on a physical device before each TestFlight submission.

**Auth**
- [ ] Fresh install: login screen appears, credentials accepted, feeds load
- [ ] Invalid credentials show an error message
- [ ] Logout clears session and returns to login screen
- [ ] Re-login works without reinstalling

**Feeds**
- [ ] All four feeds load (Members Area, Members Forum, Stock Insights, Options Insights)
- [ ] Pull-to-refresh updates content
- [ ] Posts marked read persist after app restart
- [ ] "Mark all read" clears all badges in that feed
- [ ] Tapping a `[new]` badge on a flat-feed post marks it read without opening it
- [ ] Tapping a post opens it in the system browser, authenticated (`feed_token` present in the URL)

**Topics (forum feeds)**
- [ ] Topics appear and are sorted by most recently active
- [ ] Tapping a topic expands its posts
- [ ] Topic preview snippet shows only when topic has unread posts
- [ ] Tapping topic `[new]` badge marks topic read without navigating away

**Tab badges**
- [ ] Unread badges appear on all tabs with unread content on launch (seeded locally from `scope_guids`, before the first network fetch lands)
- [ ] Badges clear when feed is viewed and posts are marked read

**Settings**
- [ ] Forum visibility toggles hide/show Stock Insights and Options Insights tabs
- [ ] Re-enabling a hidden forum shows its correct badge promptly (triggers an immediate refresh), not stale state from before it was hidden
- [ ] Refresh interval change takes effect on next timer fire
- [ ] Notification settings: enable/disable, author filter add/remove, min length slider
- [ ] Long-press on a post adds its author to the notification whitelist
- [ ] Test notification button fires a notification (`__DEV__` only)

**Background & notifications**
- [ ] Background fetch fires after app is closed for >15 min (physical device only)
- [ ] Push notification received while app is closed; tap opens correct content
- [ ] Local notification fires for new post matching author filter

**Dark / light mode**
- [ ] All screens render correctly in both modes
- [ ] Mode switches dynamically with system setting

**Edge cases**
- [ ] Stock/Options Insights show empty state gracefully if account lacks access
- [ ] App recovers cleanly from airplane mode (no crash, shows stale data)

## Development Notes

- **Strict TypeScript**: All files use `tsconfig.json` with `strict: true`. Zero compiler errors.
- **ESLint**: Uses expo config, ignores `/dist/*` directory
- **Token Management**: Feed token is app-level state, not synced per-feed
- **XML Parsing**: Handles both single items and arrays in RSS channels
- **Error States**: FeedService checks HTTP 401/403 defensively, but the live server never returns them — the real "no access" signal is zero items in the response (see Feed Aggregation → Error Handling above). Non-200 responses return `error`.
- **Async Storage**: All storage operations are async; no synchronous access patterns
- **Batch writes**: When marking multiple items read, always use `markAllRead()` — concurrent `markRead()` calls race on the same storage key
- **Read State**: Tracked via `readStateService`'s unified `scope_guids` store; `hasUnread` is boolean everywhere (no counts) and updates in real time as posts are viewed
- **Feed Organization**: Uses `FeedKey` type to ensure type-safe feed references throughout app
- **Post Link Auth**: RSS `<link>` values never carry `feed_token` — `ForumFeed.tsx`'s `openPostLink()` appends it via `URL.searchParams.set('feed_token', token)` before opening the link with `Linking.openURL()` in the system browser (not an in-app WebView)
- **State updaters**: Do not perform async side effects (e.g. storage writes) inside React `setState` updater functions — run them before the state update and await completion

## File Structure

```
~/development/LogicalInvestor/
├── app/
│   ├── _layout.tsx          ← Root layout, Stack.Protected auth gate, provider tree
│   ├── login.tsx            ← Login screen
│   └── (tabs)/
│       ├── _layout.tsx      ← Tab bar with badges; per-forum tabs
│       ├── index.tsx        ← Redirects to members-area
│       ├── members-area.tsx ← Flat feed tab
│       ├── members-forum.tsx← Topic-based feed tab
│       ├── stock-insights.tsx
│       ├── options-insights.tsx
│       └── settings.tsx     ← Logout, forum visibility, refresh interval
├── components/
│   └── ForumFeed.tsx        ← Core feed UI (flat + topic modes)
├── contexts/
│   ├── ForumVisibilityContext.tsx ← Which optional tabs are shown
│   └── FeedContext.tsx            ← Tab badge state + foreground refresh timer
├── services/
│   ├── authService.ts       ← Login, token storage, isAuthenticated()
│   ├── backgroundFetchService.ts ← expo-background-task registration
│   ├── feedService.ts       ← RSS fetching/parsing, FEEDS config
│   ├── readStateService.ts  ← Unified scope_guids read/unread store (use markAllRead/markGuidsRead for batches)
│   ├── storageService.ts    ← iCloud/AsyncStorage abstraction
│   ├── subscriptionService.ts ← Topic subscription state
│   └── topicService.ts      ← Topic discovery, persistence, sorting
├── hooks/
│   ├── use-color-scheme.ts  ← Dark/light mode detection
│   ├── use-color-scheme.web.ts ← Web variant
│   ├── use-notification-permissions.ts ← Request permissions on launch
│   └── use-theme-color.ts  ← Theme color application
├── constants/
│   └── theme.ts            ← Color and font definitions
├── .node-version           ← Contains "24"
├── app.json                ← Expo config, iCloud entitlement included
├── tsconfig.json           ← Strict TypeScript
├── eslint.config.js        ← ESLint configuration
└── .gitignore              ← /ios and /android excluded (generated)
```
