# Release History

## 0.10.2 — July 2026

- Fixed the notification settings sliders (min content length, feed refresh interval) sending a server update on every drag frame instead of once the value settles — could flood the server with requests during a single adjustment
- Notification settings now use an "Apply" button — changes to the alert tier, author whitelist, or minimum length take effect when you tap Apply, instead of each edit sending its own update immediately
- Fixed: the "Actionable" alert tier could be silently suppressed by your author whitelist even though that tier isn't supposed to use it — if you'd customized your whitelist, you may have been missing genuine actionable alerts
- Fixed: the "Length" alert tier could reject a post that the "Actionable" tier alone would have allowed, for the same reason
- Hiding a forum (Stock Insights, Options Insights) in Settings now also stops push notifications for it, instead of continuing to alert on content you've hidden
- Fixed the "you don't have access to this feed" message not appearing correctly for an unsubscribed optional forum
- Silencing a topic now asks for confirmation first, and the "[new]" badge next to it is easier to tap without hitting the silence button by mistake
- Increased base text size across the app for readability

## 0.10.1 — July 2026

- Read/unread tracking reworked: unread status for every feed and forum topic is now tracked more reliably, closing gaps where badges could show stale or incorrect state. Note: this is a one-time reset — everyone's read history and topic subscriptions start fresh once on this update
- Fixed a false-positive push alert on hedge-style posts (e.g. "could either drop... or rally...") being flagged as an actionable trade call when it wasn't one
- Notification settings screen no longer shows the min-length/author controls under tiers where they don't apply
- Improved push notification reliability and server efficiency (registration cleanup, reduced duplicate delivery risk)

## 0.10.0 — July 2026

- Notification filters redesigned: choose one of three alert tiers per device — Members Area, Actionable trade calls only, or everything past a length threshold — replacing the old single global author/length filter. Server-side push now applies the exact same rules as in-app filtering
- Fixed: muted topics could still trigger a notification
- Fixed: reopening the app after a long gap could fire a burst of notifications for an entire backlog at once, instead of just what's new
- Fixed: HTML entities like apostrophes could render broken ("isn t" instead of "isn't") in post previews and notifications
- Fixed: reply titles could leak a literal "Reply To: " prefix into the UI
- Fixed: a newly-discovered forum topic's full reply history could trigger a flood of notifications for old posts at once
- Fixed: a temporary network hiccup during the server's periodic access check could permanently revoke a paying subscriber's push notifications
- Fixed: stale unread badges when losing feed access, missing topic discovery in Options Insights, and mislabeled topic-feed items
- Fixed: push notifications could get stuck after logging out and back in, or after a failed registration call

---

## 0.9.5 — July 2026

- Local notifications now also fire on foreground refresh, not just the background task — background tasks are scheduled opportunistically by iOS/Android and can be skipped for hours
- Fixed stale push registrations: the server now re-checks each device's subscription access on every notify-worthy run and stops pushing content you've lost access to, instead of continuing indefinitely
- Unread badges for tabs you haven't opened yet now appear immediately on launch, instead of only after visiting that tab once

---

## 0.9.4 — July 2026

- Added local and background notification support for Android
- Fixed a bug where users without a Stock Insights or Options Insights subscription could still receive push alerts for that forum
- Starred topics in Stock/Options Insights no longer alert on every reply in the thread — only replies with real trade content do, cutting down noise from "good job"-style replies
- Fixed an Android cold-start issue where feeds could fail to load on first launch
- Notification reliability fixes: prevented cross-feed notification floods and a duplicate-count bug in alert stats
- Restored Members Forum as the default landing tab when nothing is unread (had regressed to Members Area in a prior release)

---

## 0.9.3 — June 2026

- Tapping a push or local notification now opens the post directly in Safari
- Badge counts for topic-based feeds (Members Forum, Stock Insights, Options Insights) are now computed consistently between background fetch and the in-app view — should fix the persistent unread badge that appeared on launch even with no new posts
- App now opens to the most relevant tab on launch:
  - Last visited tab, if it has unread content
  - Otherwise, first tab with unread content
  - Otherwise, last visited tab
  - Otherwise, Members Forum
  - Hidden forums are excluded from selection

---

## 0.9.2

- Notification filter overhaul: alerts can now be triggered by topic content (e.g. posts with a `*` prefix in Stock Insights) in addition to author filters
- Missed-alert reporting: long-press any post to report it as a missed notification, helping tune filter thresholds
- Push channel registration moved to a central feed manager — fixes an edge case where channels could be registered before the feed confirmed accessibility

---

## 0.9.1

- Per-subscription push channels: Stock Insights and Options Insights now have independent push notification channels, so the server only sends alerts for forums you have access to
- iCloud sync re-enabled: read state and preferences sync across your devices automatically
- App Store submission fixes

---

## 0.9.0

- Remote push notifications via APNs: new posts matching your alert filters now trigger a push notification even when the app is closed, without relying on background fetch
- Cloudflare Worker backend handles feed polling and APNs delivery
