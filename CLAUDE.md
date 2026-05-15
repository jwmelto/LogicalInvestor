# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LogicalInvestor is a React Native (Expo) iOS/Android app that serves as a full replacement for visiting logicalinvestor.net. It reads paywalled WordPress/bbPress forum content using a per-user feed token for authentication. The app is intended to be distributed to other subscribers of the site, not just personal use.

The app requires authentication via WordPress login, stores credentials securely, and syncs data across devices (iCloud on iOS, AsyncStorage on other platforms).

## Development Environment

**Project path:** `~/development/LogicalInvestor`  
**Bundle ID:** `space.melton.logicalinvestor`  
**Git branch:** `main`

### Machines
- Mac Mini (zsh)
- iMac

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

## Architecture

### Core Principle

No backend. The app talks directly to logicalinvestor.net. Everything is token-authenticated via a per-user feed token appended as `?feed_token=<token>` to all URLs (feeds AND page loads).

### Routing & Navigation

**File**: `app/_layout.tsx` (root layout)

The app uses a protected routing pattern:
- **Authentication Guard**: Routes protected via `<Stack.Protected guard={authed}>`
- Unauthenticated users see `login` screen
- Authenticated users see `(tabs)` layout (home) with modal and post routes available
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

#### `readStateService.ts` - Read/Unread Tracking

Tracks which posts user has viewed. Stores read post IDs in storage. Feed sections display unread badge counts. Tapping a post marks it read immediately, decrements badge.

#### `subscriptionService.ts` - Topic Subscriptions

Per-topic boolean subscriptions, default `true` for unseen topics. Unsubscribed topics hidden from feed view. **LOCAL ONLY** — does not interact with site's email subscription system.

### UI Structure

**Tabs Layout**: `app/(tabs)/_layout.tsx`
- Bottom tab navigation with two main tabs
- Home screen (`index.tsx`) — feed display
- Settings screen (`settings.tsx`) — logout button, (future: topic subscriptions)

**Additional Screens**:
- `login.tsx` — Authentication screen
- `modal.tsx` — Modal presentation
- `post.tsx` — WebView post detail viewer (headerShown: true, loads authenticated feed URL with token appended via `URL.searchParams.set()`)

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

## Current Features & State

### Implemented
- ✅ WordPress authentication with secure token storage
- ✅ Multi-feed RSS aggregation (4 feeds: Members Area, Forum, Stock/Options Insights)
- ✅ Collapsible feed sections with expand/collapse toggle
- ✅ Unread count tracking per feed (section and topic level)
- ✅ Read state persistence
- ✅ Post detail viewer with WebView
- ✅ Pull-to-refresh on main feed
- ✅ Dark/light mode support
- ✅ Cross-platform (iOS with iCloud sync, Android, Web)
- ✅ Inaccessible feeds filtered out (Options Insights hidden if no access)
- ✅ Logout clears token and redirects to login
- ✅ iCloud/AsyncStorage storage abstraction in place
- ✅ Topic discovery & display: Auto-discover forum topics from RSS, extract actual slugs from post links, nested hierarchical UI (Forum → Topic → Posts), lazy-load topic feeds, per-topic subscription backend
- ✅ Topic UX improvements:
  - Topic previews (author/excerpt) persist across feed refreshes
  - Tappable [new] badge to mark entire topic as read (works collapsed or expanded)
  - Topic posts always show snippets (hideSnippetOnRead doesn't apply to topics)
  - Topic preview hides when preview post is marked as read
  - Topic posts load during initial build if topic was previously expanded

### Not Yet Implemented (Prioritized)

1. **Dynamic Forum Tabs** — Replace single-feed view with per-forum tabs
   - Each forum becomes its own tab (Members Forum, Stock Insights, Options Insights)
   - Forums can be enabled/disabled via Settings
   - Disabled forums' tabs are completely hidden (not grayed out)
   - Only visible forums appear in tab bar

2. **Topic Subscription UI** in Settings screen
   - Per-forum default subscription toggles
   - List of all discovered topics with individual subscribe/unsubscribe
   - "Silenced Topics" section to restore previously hidden topics

3. **"Thanks" Post Filtering** (filter titles containing "Reply To: Thanks")
4. **Push Notifications** (Members Area always notifies; forum topics notify if subscribed)
5. **Android Build** (untested)
6. **iCloud Sync Testing** on physical device (requires Apple Developer account)
7. **Search** (deferred; use site's native search via WebView)
8. **deploymentTarget: "16.0"** not yet set in `app.json` iOS section

### Known Issues

**Minor Bugs**:
- Back button label shows "(tabs)" instead of "Feed" → Fix: add `title: 'Feed'` to `Stack.Screen` for `(tabs)` in `_layout.tsx`
- 4 moderate npm vulnerabilities in toolchain (uuid, glob, rimraf, inflight) — Expo upstream, do NOT run `npm audit fix --force` (will downgrade Expo)
- `ld: ignoring duplicate libraries: '-lc++'` — Harmless Xcode 16 warning

**Behavior Notes**:
- reCAPTCHA widget may appear in WebView occasionally — passes automatically in testing
- WebView correctly navigates to post anchor (e.g. `#post-287927`) automatically
- Optional subscription feeds (Stock Insights, Options Insights) return 0 items if user lacks access — correct behavior, not a bug
- Topic discovery logs each discovered topic with its feed URL (`[Topic Discovery] NVO → https://logicalinvestor.net/forums/topic/nvo/feed/`) — remove before production
- Topic previews hide `hideSnippetOnRead` setting; individual topic posts always show snippets for conversation context
- Topic [new] badge is tappable from both collapsed and expanded states to quickly mark all posts read

## Development Notes

- **Strict TypeScript**: All files use `tsconfig.json` with `strict: true`
- **ESLint**: Uses expo config, ignores `/dist/*` directory
- **Token Management**: Feed token is app-level state, not synced per-feed
- **XML Parsing**: Handles both single items and arrays in RSS channels
- **Error States**: FeedService returns `accessible: false` for 401/403, optional `error` for other failures
- **Async Storage**: All storage operations are async; no synchronous access patterns
- **Read State**: Tracked via `readStateService`, unread counts updated real-time when posts are viewed
- **Feed Organization**: Uses `FeedKey` type to ensure type-safe feed references throughout app
- **WebView Auth**: Post URLs include token via `URL.searchParams.set('feed_token', token)`

## File Structure

```
~/development/LogicalInvestor/
├── app/
│   ├── _layout.tsx          ← Root layout, Stack.Protected auth gate
│   ├── login.tsx            ← Login screen
│   ├── post.tsx             ← WebView post viewer
│   └── (tabs)/
│       ├── _layout.tsx      ← Tab bar (Feed + Settings)
│       ├── index.tsx        ← Feed screen (collapsible sections)
│       └── settings.tsx     ← Settings (logout button, future: subscriptions)
├── services/
│   ├── authService.ts       ← Login, token storage, isAuthenticated()
│   ├── feedService.ts       ← RSS fetching/parsing, FEEDS config
│   ├── storageService.ts    ← iCloud/AsyncStorage abstraction
│   ├── readStateService.ts  ← Read/unread tracking
│   └── subscriptionService.ts ← Topic subscription state
├── hooks/
│   ├── use-color-scheme.ts  ← Dark/light mode detection
│   ├── use-color-scheme.web.ts ← Web variant
│   └── use-theme-color.ts   ← Theme color application
├── components/              ← UI components (themed views, icons, etc.)
├── constants/
│   └── theme.ts            ← Color and font definitions
├── .node-version           ← Contains "24"
├── app.json                ← Expo config, iCloud entitlement included
├── tsconfig.json           ← Strict TypeScript
├── eslint.config.js        ← ESLint configuration
└── .gitignore              ← /ios and /android excluded (generated)
```
