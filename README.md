# LogicalInvestor

Push notification backend for logicalinvestor.net, a paywalled WordPress/bbPress site.
No app, no backend server beyond a single Cloudflare Worker — it polls the site's RSS feeds on a cron schedule and pushes alerts to registered browsers.

## What This Is

- **`cloudflare-worker/`** — the Worker: polls feeds per channel, classifies posts (member-only / actionable trade call / by length), and delivers Web Push notifications
- **`packages/core/`** — shared, framework-free TypeScript: feed parsing, filter tiers, actionable-post classification
- **`web-push/`** — a static page (no build step) that registers a browser for push notifications, served by the Worker itself via Workers Static Assets
- **`docs/`** — design notes for the notification filtering system

## Development

See **CLAUDE.md** for architecture, commands, and deployment details.

## Authentication

Registration requires a valid per-user `feed_token` from logicalinvestor.net, verified against the site before the Worker stores a registration.
