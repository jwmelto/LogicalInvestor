# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
- **WebView**: `react-native-webview` (post viewer)
- **UI Components**: Native React Native components with custom theming
- **Background Tasks**: `expo-background-fetch` + `expo-task-manager`

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
eas build --platform ios           # Create production build for App Store
```

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

**Topic Sub-feeds**: For a topic URL like `https://logicalinvestor.net/forums/topic/nvo/`, the sub-feed is `https://logicalinvestor.net/forums/topic/nvo/feed/`. Derived dynamically in `fetchTopicFeed()` — no hardcoding needed.

**Parsing**: Uses `fast-xml-parser` with config:
```typescript
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});
```
Parse path: `parsed?.rss?.channel?.item`. Handle both single items and arrays (wrap single item in array).

**Error Handling**: 
- 401/403 → `accessible: false` (user lacks access)
- Other errors → `accessible: true` with optional `error` message

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

**iCloud Setup**: Entitlement already in `app.json`:
```json
"entitlements": {
  "com.apple.developer.ubiquity-kvstore-identifier": "$(TeamIdentifierPrefix)$(CFBundleIdentifier)"
}
```
Full iCloud sync requires Apple Developer account + physical device. Simulator uses AsyncStorage fallback silently.

**iCloud strategy**: iCloud KVS is the right cross-platform approach for this app. No backend is a core principle, and iCloud KVS provides free cross-device sync on iOS with a transparent AsyncStorage fallback on Android. The library's TypeScript types lag behind its API in one place (`getObject` is not typed as generic); work around with a cast at the callsite rather than changing the approach.

#### `readStateService.ts` - Read/Unread Tracking

Tracks which posts have been viewed. Stores read post IDs as an array in storage.

**Important**: Always use `markAllRead(ids[])` when marking multiple items at once. Individual `markRead()` calls run concurrent read-modify-write cycles on the same storage key and will race/overwrite each other.

**Key Functions**: `isRead()`, `markRead()`, `markAllRead()`, `getUnreadCount()`

#### `subscriptionService.ts` - Topic Subscriptions

Per-topic boolean subscriptions, default `true` for unseen topics. Unsubscribed topics hidden from feed view. **LOCAL ONLY** — does not interact with site's email subscription system.

#### `topicService.ts` - Topic Discovery

Discovers forum topics from RSS feed items, persists them across sessions. Topics are sorted by `lastUpdatedAt` so active discussions float to the top.

**Key Functions**: `updateTopicsFromFeedItems()`, `getTopicsForForum()`, `generateTopicFeedUrl()`, `extractTopicFromTitle()`

#### `backgroundFetchService.ts` - Background Refresh

Registers an `expo-background-fetch` task that fetches all feeds while the app is closed. After fetching, computes per-feed unread counts and writes them to `cached_unread_counts` in storage, so tab badges are accurate on next app launch without a network call.

**Note**: Background fetch only runs on physical devices. Simulator always uses AsyncStorage fallback and background tasks do not fire.

### Contexts

**Location**: `contexts/` directory

#### `UnreadCountContext.tsx` - Unread Badge State + Refresh Timer

Central store for per-feed unread counts that drives tab bar badges. Also owns the foreground refresh timer.

**Badges**: Each `ForumFeed` publishes its unread count here after loading. The tab layout reads counts and sets `tabBarBadge`. On app launch, counts are seeded from `cached_unread_counts` in storage so all badges appear immediately.

**Foreground refresh timer**:
- Fires every N minutes (configured via `getRefreshInterval()`, default 30 min)
- Increments `refreshSignal`; all mounted `ForumFeed` components re-fetch when signal changes
- Pauses when app is backgrounded (no JS wakeups)
- On foreground return: resumes with remaining time if not yet due; fires after 1.5s delay if overdue (delay lets any in-flight `markRead` writes settle before re-fetching)
- Manual pull-to-refresh calls `notifyManualRefresh()` to reset the timer from zero

#### `ForumVisibilityContext.tsx` - Forum Tab Visibility

Persists which optional forum tabs (Stock Insights, Options Insights) are enabled. Drives `href: null` in the tab layout to hide disabled tabs entirely.

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
- `post.tsx` — WebView post detail viewer (headerShown: true, loads authenticated URL with token via `URL.searchParams.set()`)

**`ForumFeed` component** (`components/ForumFeed.tsx`):
The core UI component. Handles flat feeds (Members Area) and topic-based feeds (forum tabs).
- Header row shows forum title + "Mark all read" button when unread items exist
- Flat feeds: individual `[new]` badges are tappable to mark that post read without opening it
- Topic feeds: hierarchical display (Topic → posts), tappable `[new]` badge per topic, topic preview snippet (latest post) shown only when `unreadCount > 0`
- Pull-to-refresh triggers `notifyManualRefresh()` on the context to reset the timer

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
- ✅ Background fetch (physical device only) — keeps feed data fresh and updates cached badge counts
- ✅ Pull-to-refresh resets the foreground timer
- ✅ Post detail viewer with WebView
- ✅ Dark/light mode support
- ✅ Cross-platform (iOS with iCloud sync, Android, Web)
- ✅ Inaccessible feeds filtered out (Options Insights hidden if no access)
- ✅ Logout clears token and redirects to login
- ✅ iCloud/AsyncStorage storage abstraction; TypeScript strict mode clean (zero compiler errors)

### Not Yet Implemented (Prioritized)

1. **Topic Subscription UI** in Settings screen
   - Per-forum default subscription toggles
   - List of all discovered topics with individual subscribe/unsubscribe
   - "Silenced Topics" section to restore previously hidden topics

2. **"Thanks" Post Filtering** (filter titles containing "Reply To: Thanks")
3. **Push Notifications** (Members Area always notifies; forum topics notify if subscribed)
4. **Android Build** (untested)
5. **iCloud Sync Testing** on physical device (requires Apple Developer account)
6. **Search** (deferred; use site's native search via WebView)

### Known Issues

**Minor Issues**:
- 4 moderate npm vulnerabilities in toolchain (uuid, glob, rimraf, inflight) — Expo upstream, unfixable without breaking Expo
- `ld: ignoring duplicate libraries: '-lc++'` — Harmless Xcode 16 warning
- Debug `console.log` for Members Area XML still present in `feedService.ts` (line ~86)

**Behavior Notes**:
- reCAPTCHA widget may appear in WebView occasionally — passes automatically in testing
- WebView correctly navigates to post anchor (e.g. `#post-287927`) automatically
- Optional subscription feeds (Stock Insights, Options Insights) return 0 items if user lacks access — correct behavior, not a bug
- Background fetch does not run in simulator — requires physical device
- `section.unreadCount` on topic-based feeds reflects the top-level 25-item feed window, not the strict sum of per-topic unread counts; this is a known approximation

## Development Notes

- **Strict TypeScript**: All files use `tsconfig.json` with `strict: true`. Zero compiler errors.
- **ESLint**: Uses expo config, ignores `/dist/*` directory
- **Token Management**: Feed token is app-level state, not synced per-feed
- **XML Parsing**: Handles both single items and arrays in RSS channels
- **Error States**: FeedService returns `accessible: false` for 401/403, optional `error` for other failures
- **Async Storage**: All storage operations are async; no synchronous access patterns
- **Batch writes**: When marking multiple items read, always use `markAllRead()` — concurrent `markRead()` calls race on the same storage key
- **Read State**: Tracked via `readStateService`, unread counts updated real-time when posts are viewed
- **Feed Organization**: Uses `FeedKey` type to ensure type-safe feed references throughout app
- **WebView Auth**: Post URLs include token via `URL.searchParams.set('feed_token', token)`
- **State updaters**: Do not perform async side effects (e.g. storage writes) inside React `setState` updater functions — run them before the state update and await completion

## File Structure

```
~/development/LogicalInvestor/
├── app/
│   ├── _layout.tsx          ← Root layout, Stack.Protected auth gate, provider tree
│   ├── login.tsx            ← Login screen
│   ├── post.tsx             ← WebView post viewer
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
│   └── UnreadCountContext.tsx     ← Tab badge counts + foreground refresh timer
├── services/
│   ├── authService.ts       ← Login, token storage, isAuthenticated()
│   ├── backgroundFetchService.ts ← expo-background-fetch task registration
│   ├── feedService.ts       ← RSS fetching/parsing, FEEDS config
│   ├── readStateService.ts  ← Read/unread tracking (use markAllRead for batches)
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
