# Release History

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
