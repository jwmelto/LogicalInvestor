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

Feature branches merge to `main`: `feature/<slug>` (e.g. `feature/push-notifications`), `fix/<slug>`, `docs/<slug>`, `chore/<slug>`. This repo squash-merges every PR — see the global git workflow notes (`~/.claude/CLAUDE.md`) for what that implies for branch stacking and issue-number tagging.

Track planned work, bugs, and open questions as GitHub Issues — not in this file. A roadmap list here goes stale the moment work lands and nobody remembers to edit it back out. Before committing a fix for a bug reported conversationally (no issue number given), check `gh issue list --search "<keyword>"` — it may already be filed.

Never run `wrangler deploy`, or ask about deploying the Cloudflare Worker — the user always deploys it themselves.

Never run `npx expo prebuild` or delete `ios/`/`android/` without asking first: an incremental prebuild usually preserves Xcode signing config, but a full regen from a missing `ios/` wipes it (no `ios.appleTeamId` in `app.json`).

Don't probe the live logicalinvestor.net site with curl to test a hypothesis about URL/routing/feed behavior — ask the user directly; they have first-hand knowledge of how the site works.

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

### Testing
```bash
npm test                              # Run app test suite
npm test -- <path>                    # Run a specific test file
npm test --prefix cloudflare-worker   # Run Worker test suite (no cd needed)
```
Typecheck the Worker without `cd`: `tsc -p cloudflare-worker/tsconfig.json`.

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

**Version bump timing**: Bump `package.json`'s `version` as the first commit on a release branch, not right before the build (see `~/.claude/CLAUDE.md` for the general version-bump-timing principle). `app.config.js` reads `version` directly from `package.json` at build time; `app.json` has no `version` field, so there's nothing to sync there manually. The build *number* (distinct from version) auto-increments separately via `eas.json`'s `autoIncrement: true` on the `production` profile.

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

**Topic Sub-feeds**: For a topic URL like `https://logicalinvestor.net/forums/topic/zqr/`, the sub-feed is `https://logicalinvestor.net/forums/topic/zqr/feed/`. Derived dynamically in `fetchTopicFeed()` — no hardcoding needed.

**Parsing**: Uses `fast-xml-parser` with config:
```typescript
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});
```
Parse path: `parsed?.rss?.channel?.item`. Handle both single items and arrays (wrap single item in array).

**Error Handling**: The real "no access" signal is **zero items returned**:
Members Forum, Stock Insights, and Options Insights all return `<item>`-less RSS with a bad or missing token.
Members Area is the exception.
It always returns items (only the content snippet is paywalled),
so it's structurally incapable of signaling a dead token.
This is also why Stock/Options Insights returning 0 items is treated as "not subscribed" rather than an error (see below).
All four feed URLs return HTTP 200 regardless of token validity (verified against the live server).
A dead token never surfaces as a 401/403,
so `FeedResult` carries only `items` and an optional `error` (set for non-200 responses and network failures).

**Key Functions**: `fetchAllFeeds()`, `fetchSingleFeed()`, `fetchTopicFeed()`  
**Return Shape**: `FeedResult` with items array, optional error

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

**Mutation is always multi-scope and batched**: `markScopesSeen(updates)` inserts newly-seen guids as unread.
It never resurrects an already-read guid that resurfaces in a refetch.
`markGuidsRead(updates)` flips guids to read.
Both take `Record<scopeId, guid[]>` so "mark this whole forum read" (spanning several topics) is one read-modify-write, not one per topic.
Concurrent individual writes to the same storage key race and overwrite each other.
`markScopesRead(scopeIds)` is the higher-level "mark everything currently known in these scopes as read" operation built on `markGuidsRead`.
A scope is a scope regardless of whether it's a flat feed key or a topic id.
So this is the one function both `ForumFeed.tsx`'s "mark all read" and its per-topic "mark read" use,
just with a different-length scope id list.
It returns what it marked so the caller can reflect it locally without re-deriving.
`markRead(scopeId, guid)`/`markAllRead(scopeId, guids)` are single-scope convenience wrappers over `markGuidsRead`.
They're fine for one-off calls, but never call them in a loop over many items.
Batch-load `getAllScopes()` once and use `viewScope()` instead.
See `detectForumUnread`'s implementation for the pattern.
`clearScope(scopeId)` removes a scope entirely.
It's called when a topic is confirmed deleted, so no leftover read-state carries forward if that topic id is ever seen again.

**`viewScope(guids)`**: a pure, synchronous, read-only view (`{ hasUnread, isRead(guid) }`) over an already-loaded scope.
No I/O, no stored mutable state.
Two independently-loaded views of the same scope would race if each saved its own mutations,
so all mutation goes through the batch functions above instead.

**`detectForumUnread(forumKey, topLevelItems)`**: the per-topic detection algorithm.
It relies on a completeness proof rather than a schedule.
The bbPress RSS feed reliably returns items newest-first.
Walking newest→oldest, skipping silenced topics entirely:
1. If the newest considered item is already known, nothing changed.
2. If a known item is hit before the window is exhausted, everything before it is provably the complete set of new posts.
   Attribution is via `extractTopicSlugFromLink`, never by title.
3. If the whole window is exhausted with nothing known,
   every subscribed topic gets its own feed fetched directly via `feedService.fetchTopicFeed`.
   These fetches run concurrently (`Promise.all`),
   so this costs one round-trip's worth of latency regardless of topic count.
   There's no cap on topic count, since a cap here would only mean a cold/inactive topic could go unchecked indefinitely.
   See `topicService.ts` for how a topic confirmed deleted by one of these fetches gets removed rather than tracked.

Returns `hasUnread` for every topic touched this pass.
An untouched topic provably didn't change.

**`markFlatFeedSeen(feedKey, items)`**: the flat-feed equivalent.
No boundary-walk is needed, since there's no per-item fetch cost to save.
Every fetch just records its whole window as seen.

**`topicUnreadForForum(forumKey, scopes, subs)`**: a pure, synchronous helper deriving every subscribed topic's `hasUnread` for a forum
directly from an already-loaded `scopes`/`subs` snapshot.
No I/O, no topic-registry read.
Which topics belong to a forum is derived from scanning `scopes`' own keys for the `"{forumKey}:"` prefix.
Shared by both `FeedContext.tsx`'s cold-start seed and `app/(tabs)/index.tsx`'s landing-tab decision,
so the same derivation isn't duplicated across the two.

**`feedHasUnread(feedKey, hasSubFeeds, scopes, subs)`**: a pure, synchronous predicate for whether a feed has any unread content at all.
A flat feed's answer comes from its own scope.
A topic-based forum's answer comes from every one of its topics' scopes, via `topicUnreadForForum`.
The one definition of "unread" for a whole feed,
so callers don't each compute it differently depending on which kind of feed they happen to be looking at.

**`updateTopic(topic, feedKey)`**: the single entry point `ForumFeed.tsx` uses to refresh one topic's content.
It fetches via `feedService.fetchTopicFeed`.
It then performs whichever scope update the result implies: `clearScope` on deletion, `markScopesSeen` otherwise.
It returns the fetch result unchanged.
The view never calls `fetchTopicFeed`, `markScopesSeen`, or `clearScope` directly for this.
It only reacts to what `updateTopic` returns.
`detectForumUnread`'s own deep-dive calls `fetchTopicFeed` directly instead,
batching many topics' scope writes into one call for efficiency.
`updateTopic` is for `ForumFeed`'s two single-topic call sites:
an already-expanded topic's own fetch in `buildSection`,
and a manual expand via `loadTopicPosts`.

**`pruneOrphanedScopes(validScopeIds)` / `pruneOrphanedScopesForAllFeeds()`**: removes any `scope_guids` entry not in a given valid set.
An orphan is a topic id with a scope entry but no matching topic record.
It's invisible everywhere a topic would normally render.
But `topicUnreadForForum` trusts `scope_guids`' own keys as the current topic list,
so an orphan would silently keep propping up its forum's badge forever.
The `ForAllFeeds` wrapper builds the valid set from the topic/feed registry,
not from `scope_guids` itself:
every flat feed key, plus every topic id `getTopicsForForum` currently returns for each forum.
It then calls `pruneOrphanedScopes` with that set, which removes anything present in `scope_guids` but absent from it.
Run by `FeedContext.tsx` at cold start and on every `fetchAllFeeds` pass.
Cheap enough that any future regression of this class self-heals on the next poll, rather than needing an app restart.

**Key Functions**: `hasUnread()`, `isRead()`, `markRead()`, `markAllRead()`, `markScopesSeen()`,
`markGuidsRead()`, `markScopesRead()`, `clearScope()`,
`pruneOrphanedScopes()`, `pruneOrphanedScopesForAllFeeds()`,
`markFlatFeedSeen()`, `detectForumUnread()`, `topicUnreadForForum()`, `feedHasUnread()`,
`updateTopic()`, `viewScope()`, `getAllScopes()`

#### `subscriptionService.ts` - Topic Subscriptions

Per-topic boolean subscriptions, default `true` for unseen topics. Unsubscribed topics hidden from feed view. **LOCAL ONLY** — does not interact with site's email subscription system.

#### `topicService.ts` - Topic Discovery

Discovers forum topics from RSS feed items, persists them across sessions. Topics are sorted by `lastUpdatedAt` so active discussions float to the top.

**Identity is slug-based, not title-based**: `generateTopicId(forumKey, slug)` builds a topic's id from its (mostly immutable) URL slug, not its title — a moderator editing a title, or an unrelated new topic reusing an old one, would otherwise break identity. `discoverTopicsFromFeedItems` groups by slug; `name` (display) still comes from whichever item's title first created the record.

**Deleted-topic detection**: a deleted topic's permalink doesn't reliably 404 on this site.
The bare page 404s.
Its `/feed/` suffix 200s with the *Members Forum feed* instead of erroring.
`feedService.fetchTopicFeed` detects this by checking whether the first returned item's own link still re-derives the slug it asked for.
A mismatch means the whole response is the wrong feed, not just a bad item, so it calls `deleteTopic()` and returns no items.
The record is removed outright rather than flagged.
The site itself stops listing a genuinely deleted topic in RSS, so there's no expectation of it resurfacing.
The app caches no post content locally.
It keeps only guid read-state and one preview snippet (see the `latest*` fields),
so there's nothing left worth showing once a topic is confirmed gone.
`ForumFeed.tsx` removes it from the rendered list immediately, the moment a fetch confirms it instead of displaying an empty shell.

**Key Functions**: `updateTopicsFromFeedItems()`, `getTopicsForForum()`, `generateTopicId()`, `generateTopicUrl()`, `extractTopicSlugFromLink()`, `deleteTopic()`

#### `backgroundFetchService.ts` - Background Refresh

Registers an `expo-background-task` task that fetches all feeds while the app is closed, then writes straight into the same `scope_guids` store `readStateService.ts` owns (`markFlatFeedSeen` for the flat feed, `detectForumUnread` per topic-based forum) — there's no separate cached badge snapshot; the next foreground open's cold-start seed (`FeedContext.tsx`) reads `scope_guids` directly. This task is a best-effort supplement only, not load-bearing — `expo-background-task`'s 15-minute minimum is non-deterministic on iOS, and the primary detection trigger is `FeedContext.tsx`'s foreground refresh cycle.

Skips detection entirely for a forum currently hidden in Settings (`FEEDS[k].isVisible(visibility)`) — no point spending per-topic deep-dive fetches on a badge nobody can see. The top-level fetch itself still runs for every feed regardless, so a re-enabled forum's data isn't stale.

**Note**: Background tasks only run on physical devices. Simulator always uses AsyncStorage fallback and background tasks do not fire.

#### `pushService.ts` - Push Notification Registration & Filters

All notification generation is server-side, in the Cloudflare Worker.
`pushService.ts`'s job is registering the device with the Worker and managing the filter settings sent at registration time.

**Registration**: `registerPushChannel(feedKey, feedToken, overrides?)` is called by `FeedContext.tsx`
after a feed's first successful, accessible fetch.
It resolves the Expo push token,
maps `feedKey` to a `Channel` (`FEEDKEY_TO_CHANNEL`),
and POSTs to the Worker's `/register` with the current filter settings plus `feed_token`.
It returns whether the server confirmed registration.
`FeedContext.tsx` only marks a channel registered when this returns `true`.
A `false` leaves the channel eligible to try again on the next `fetchAllFeeds` cycle, instead of getting stuck unregistered.

**Filter settings** (`PushFilterSettings`):
- `filter`: the alert tier (`ContentFilter`, see `FILTER_TIERS` in `@li/core`)
- `authors`: string whitelist
- `minLength`: stripped-content char threshold, default 200, only meaningful under the `length` tier

`updatePushSettings()` persists locally only after every registered channel confirms the update.
The Worker's `/register` writes to KV before responding `ok`,
so `response.ok` is the strongest confirmation the client has.
No separate read-back endpoint exists.
Settings screen's Apply button (a deliberate, explicit save, not on every field edit)
and `ForumFeed`'s long-press "Add author to alerts" gesture (`addPushAuthor`) both go through this same function.

**Key Functions**: `registerPushChannel()`, `updatePushSettings()`, `addPushAuthor()`, `addAuthorToList()`,
`unregisterPushToken()`, `getPushFilter()`, `getPushAuthors()`, `getPushMinLength()`

**Worker-side filtering**: the app only sends filter *settings* at registration time.
Every matching decision (`matchesFilter` in `@li/core`, called from the cron handler in `cloudflare-worker/src/index.ts`) runs in the Worker.
Members Area always notifies, at every tier — an unconditional bypass in `matchesFilter`, checked before any tier logic runs.
For every other feed, the three tiers (`FILTER_TIERS` in `@li/core`: `members`, `actionable`, `length`) are narrow to broad, each a strict superset of the one before it:
- `members`: nothing else notifies.
- `actionable`: the post must satisfy all of:
  - Author is in the Worker's own `ACTIONABLE_AUTHORS` list (`env.ACTIONABLE_AUTHORS`, default "Sean Hyman") — not the device's personal author whitelist.
  - For Stock/Options Insights only: the topic title starts with `*`.
  - Content passes both the actionable-signal negative and positive pattern checks.
- `length`: everything that qualifies at `actionable` still qualifies here unconditionally, plus anything matching the device's own author whitelist with content at least `minLength` characters long.

Every `/register` call includes `feed_token` — `registerPushChannel()` and `updatePushSettings()` both always send it.
The Worker uses it to verify access before storing the registration; see `cloudflare-worker/src/index.ts` for how each channel checks it.
One non-obvious case: the `members` channel (bundling both Members Area and Members Forum) checks access against Members Forum specifically, not Members Area — Members Area's own feed is readable regardless of token validity, so it alone would never catch an expired or invalid one.

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

#### Web Push registration page (`web-push/`)

A static page (`index.html`, `app.js`, `sw.js`, `manifest.json`, icons, no build step) that
registers a browser for push notifications. It replaces the RN app's own App Store submission,
abandoned after a Guideline 4.2.2 rejection. Apple's reviewer suggested this alternative.

It's a client of the Worker's API, not part of the Worker's own source. It lives at the repo's
top level, alongside the RN app, instead of nested under `cloudflare-worker/`. Sean Hyman
declined to host it on logicalinvestor.net, so Cloudflare hosting is permanent: the Worker
serves it via Workers Static Assets (`cloudflare-worker/wrangler.toml`'s `[assets] directory =
"../web-push"`). Local dev and phone testing use the same path: `wrangler dev` plus a
`cloudflared tunnel --url`.

**Delivery mechanism**: a second push transport alongside the RN app's Expo push path, additive
only. `cloudflare-worker/src/webpush.ts` wraps `@block65/webcrypto-web-push`. It's WebCrypto-
native and works unmodified in Workers. The canonical `web-push` npm package does not, since it
depends on Node `crypto` APIs Workers' `nodejs_compat` polyfill doesn't fully cover. `TOKENS` KV
entries gain `kind: 'webpush'` and a `subscription` object. Entries without `kind` are the
pre-existing Expo ones, unaffected. `runChannel`'s notification loop sends to both kinds in the
same pass.

**Endpoints** (`cloudflare-worker/src/index.ts`, same `/register`/`/unregister` routes the RN app
uses; the request body's `token` field means Expo, `subscription` means browser):
- `GET /vapid-public-key`: the public key. The page never hardcodes a value that would go stale on rotation.
- `POST /test-push`: sends one notification straight to the requesting device, bypassing the poll/filter pipeline. Confirms a registration actually receives pushes without waiting for real forum activity.

**VAPID key pair**: production and local dev use deliberately different key pairs.
- Production: the public half is `wrangler.toml`'s committed `VAPID_PUBLIC_KEY` var. It isn't secret. The private half is set only via `wrangler secret put VAPID_PRIVATE_KEY`, and is never written to any file in this repo.
- Local dev: `cloudflare-worker/.dev.vars.example` holds a shared, committed, test-only key pair. Copy it to `.dev.vars`, which is gitignored. This pair has never been used in production and never will be, so there's nothing meaningful to keep secret about it. `.dev.vars` overrides `wrangler.toml`'s `[vars]` during `wrangler dev` only, never during a real deploy. Local testing stays self-consistent on the test pair regardless of the production public key.
- To generate a new pair, needed only for a real production rotation (see the caveat above about breaking existing subscriptions): `npx web-push@3.6.7 generate-vapid-keys`. The version is pinned in the command instead of adding `web-push` as a project dependency, since it's a one-off human-run CLI utility never imported by any code.

**CORS**: `cloudflare-worker/src/index.ts`'s `fetch()` adds `Access-Control-Allow-Origin` for a
single configured origin (`env.CORS_ALLOWED_ORIGIN`, a `wrangler.toml` var), plus `OPTIONS`
preflight handling. Same-origin requests, today's only real case, never trigger CORS
enforcement. This code is currently dormant. No cross-origin host is configured, and none is
planned.

### Contexts

**Location**: `contexts/` directory

#### `FeedContext.tsx` - Unread Badge State + Refresh Timer

Central store for per-feed `hasUnread` booleans (`unread`) and per-topic booleans (`topicUnread`) that drive tab bar badges. Also owns the foreground refresh timer and orchestrates unread detection.

**Badges are always derived fresh from the model, never merged incrementally.**
A cold-start seed effect first prunes orphaned `scope_guids` entries,
via `pruneOrphanedScopesForAllFeeds` in `readStateService.ts`.
An orphan is a topic id with no matching topic record anymore,
such as from a build that deleted a topic before scope-clearing existed alongside deletion.
It then computes every badge directly from the local `scope_guids` store: the flat feed, and every subscribed topic in every forum.
Zero network calls, before the first fetch even lands.
Each poll cycle (`fetchAllFeeds`) runs detection writes first:
`markFlatFeedSeen` for the flat feed,
`detectForumUnread` per topic-based forum, plus a re-sweep for orphans.
It then re-derives badge state for every feed touched that cycle in one shared pass:
`feedHasUnread(feedKey, hasSubFeeds, scopes, subs)` for the flat feed,
`topicUnreadForForum(forumKey, scopes, subs)` for each topic-based forum's per-topic map.
A merge can only ever add or overwrite keys it's told about.
A topic deleted mid-pass would never be told about, so its last-known state — however stale — would stay stuck forever.
Deriving fresh has no such gap, since an absent topic in `scope_guids` is simply absent from the result.
A forum's own tab badge is always the OR across its topics' flags, kept in sync by a dedicated effect.
`refreshUnread(feedKey)` lets `ForumFeed` re-derive an entire feed's badge state, immediately after any scope mutation: mark read, mark all read, a topic confirmed deleted.

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
- ✅ Read state persistence with atomic batch writes (`markScopesRead`, `markGuidsRead`)
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
- ✅ Push notifications generated server-side (Cloudflare Worker) per a device-selected alert tier — no client-side notification generation
- ✅ Long-press any post/preview opens a dialog to add that author to the push author whitelist
- ✅ Notification settings in Settings screen: alert tier selector; author whitelist and min-length slider, both shown only under the `length` tier
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
- [ ] Notification settings: switching to the `length` tier reveals the author whitelist and min-length slider; other tiers hide both
- [ ] Author add/remove and the min-length slider value persist via Apply
- [ ] Long-press on a post opens the add-author dialog; confirming adds it to the push author whitelist

**Background & notifications**
- [ ] Background fetch fires after app is closed for >15 min (physical device only)
- [ ] Push notification received while app is closed; tap opens correct content
- [ ] Push notification respects the selected alert tier and author whitelist

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
- **Error States**: The real "no access" signal is zero items in the response (see Feed Aggregation → Error Handling above).
   Non-200 responses return `error`.
- **Async Storage**: All storage operations are async; no synchronous access patterns
- **Batch writes**: When marking multiple scopes or items read, use `markScopesRead()` or `markGuidsRead()`, not a loop of single-scope `markRead()` calls.
  Each `markRead()` call reads, modifies, and writes the same storage key independently, so overlapping calls can silently overwrite each other's results
- **Read State**: Tracked via `readStateService`'s unified `scope_guids` store; `hasUnread` is boolean everywhere (no counts) and updates in real time as posts are viewed
- **Feed Organization**: Uses `FeedKey` type to ensure type-safe feed references throughout app
- **Post Link Auth**: RSS `<link>` values never carry `feed_token` — `ForumFeed.tsx`'s `openPostLink()` appends it via `URL.searchParams.set('feed_token', token)` before opening the link with `Linking.openURL()` in the system browser (not an in-app WebView)
- **State updaters**: Do not perform async side effects (e.g. storage writes) inside React `setState` updater functions — run them before the state update and await completion
- **No warnings tolerated**: lint/build warnings in `app/`, `components/`, `services/`, `contexts/`, `hooks/`, or `cloudflare-worker/src/` are never acceptable, including ones that pre-date a given change (see `~/.claude/CLAUDE.md`'s engineering defaults). Only warnings originating upstream (a dependency, generated code) may stand.

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
│   ├── readStateService.ts  ← Unified scope_guids read/unread store (use markScopesRead/markGuidsRead for batches)
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
