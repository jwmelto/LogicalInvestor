# LogicalInvestor

A React Native (Expo) iOS/Android app that serves as a full replacement for visiting logicalinvestor.net. Aggregates paywalled WordPress/bbPress forum content using per-user feed token authentication.

## What This Is

- Full-featured RSS feed aggregator for logicalinvestor.net
- Cross-platform (iOS, Android, Web) via React Native
- Secure token-based authentication
- iCloud sync on iOS, local storage on other platforms
- Collapsible feed sections with unread badges
- WebView post viewer with authenticated links

## Quick Start

### First-time setup

Run the automated setup script:

```bash
./setup.sh
```

This installs all dependencies and configures your environment. See `SETUP.md` for manual setup or troubleshooting.

### Run the app

After setup:

```bash
npm run ios       # Build and run on iOS simulator
npm run android   # Build and run on Android emulator
npm run web       # Run web version
npm start         # Start Metro bundler (choose platform when prompted)
```

## Development

- **CLAUDE.md** — Architecture overview, tech stack, codebase structure, and known issues
- **SETUP.md** — Detailed setup instructions and troubleshooting

## Authentication

Uses WordPress login via logicalinvestor.net. Credentials are stored securely on device. Feed token is never synced to iCloud.

## Project Structure

```
app/                 — Navigation and screens (file-based routing via Expo Router)
services/            — Business logic (auth, feeds, storage, state)
components/          — UI components
constants/           — Theme and configuration
hooks/               — Custom React hooks
```

See CLAUDE.md for detailed architecture.
