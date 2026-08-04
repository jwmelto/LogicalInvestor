import { storageGetObject, storageSetObject } from './storageService';
import { FeedKey, RssItem, FEEDS, fetchTopicFeed, type TopicFeedResult } from './feedService';
import { Topic, getTopicsForForum, generateTopicId, extractTopicSlugFromLink } from './topicService';
import { getAllTopicSubscriptions } from './subscriptionService';

// Single store for all "have I seen this / have I read this" state, keyed by the tuple
// <scopeId, guid> — scopeId is either a FeedKey (the flat Members Area feed) or a topic id
// ("{forumKey}:{slug}", see topicService.generateTopicId). The two namespaces never collide: a
// topic id always contains ':' and a feed key never does. "Known" isn't tracked separately from
// "read" — presence of a guid in a scope's map means known, the boolean value means read.
const SCOPE_KEY = 'scope_guids'; // Record<scopeId, Record<guid, boolean>>

// Exported for the batch-loading call sites (FeedContext's cold-start seed, ForumFeed's
// buildSection) — they need the whole store in memory once, then work off it via viewScope()
// rather than calling the single-scope wrappers below in a loop.
export async function getAllScopes(): Promise<Record<string, Record<string, boolean>>> {
  return (await storageGetObject<Record<string, Record<string, boolean>>>(SCOPE_KEY)) ?? {};
}

// Insert guids as unread (false), but only where not already present — never resurrect an
// already-read guid just because a refetch (or a re-attributed top-level item) saw it again.
// Multi-scope so a single detection pass writes storage once, not once per scope it touched.
export async function markScopesSeen(updates: Record<string, string[]>): Promise<void> {
  const entries = Object.entries(updates).filter(([, guids]) => guids.length > 0);
  if (entries.length === 0) return;
  const all = await getAllScopes();
  const next = { ...all };
  for (const [scopeId, guids] of entries) {
    const scope = { ...(all[scopeId] ?? {}) };
    guids.forEach((g) => { if (!(g in scope)) scope[g] = false; });
    next[scopeId] = scope;
  }
  await storageSetObject(SCOPE_KEY, next);
}

// Removes a scope entirely — called when a topic is confirmed deleted (see feedService's
// fetchTopicFeed), so no read-state, legitimate or contaminated, carries forward if that topic id
// is ever seen again (whether a genuine new topic reusing the slug, or the same record resurfacing
// via a storage-sync issue). A no-op if the scope doesn't exist.
export async function clearScope(scopeId: string): Promise<void> {
  const all = await getAllScopes();
  if (!(scopeId in all)) return;
  const { [scopeId]: _removed, ...rest } = all;
  await storageSetObject(SCOPE_KEY, rest);
}

// Sweep for orphaned scope entries: a topic id that no longer corresponds to any real topic (or
// flat feed) but still has a scope_guids entry — e.g. a topic deleted by a build that predates
// clearScope existing alongside deletion. topicUnreadForForum trusts scope_guids' own keys as the
// current topic list; an orphan is invisible everywhere a topic would normally render, yet still
// silently contributes to its forum's aggregate badge forever, since nothing else ever re-checks
// "does this topic still exist." validScopeIds is the complete, currently-correct set — anything
// else present in scope_guids gets removed. A no-op (no write) if nothing was orphaned.
export async function pruneOrphanedScopes(validScopeIds: Set<string>): Promise<void> {
  const all = await getAllScopes();
  const next: Record<string, Record<string, boolean>> = {};
  let changed = false;
  for (const [scopeId, guids] of Object.entries(all)) {
    if (validScopeIds.has(scopeId)) {
      next[scopeId] = guids;
    } else {
      changed = true;
    }
  }
  if (changed) await storageSetObject(SCOPE_KEY, next);
}

// Convenience wrapper: builds the complete, currently-correct scope id set itself (every flat
// feed key, every topic id across every forum) rather than making callers assemble it — same
// "compute from the model, not the caller" principle as feedHasUnread/topicUnreadForForum above.
// Cheap enough to call on every refresh, not just once at cold start, so a future regression of
// this same class self-heals on the next poll rather than needing an app restart.
export async function pruneOrphanedScopesForAllFeeds(): Promise<void> {
  const validScopeIds = new Set<string>();
  for (const k of Object.keys(FEEDS) as FeedKey[]) {
    if (!FEEDS[k].hasSubFeeds) {
      validScopeIds.add(k);
      continue;
    }
    (await getTopicsForForum(k)).forEach((t) => validScopeIds.add(t.id));
  }
  await pruneOrphanedScopes(validScopeIds);
}

// Flip existing guids to read=true. Multi-scope so "mark this whole forum read" (spanning
// several topics) is one read-modify-write, not one per topic — concurrent individual writes to
// the same key would race and overwrite each other.
export async function markGuidsRead(updates: Record<string, string[]>): Promise<void> {
  const entries = Object.entries(updates).filter(([, guids]) => guids.length > 0);
  if (entries.length === 0) return;
  const all = await getAllScopes();
  const next = { ...all };
  for (const [scopeId, guids] of entries) {
    const scope = { ...(all[scopeId] ?? {}) };
    guids.forEach((g) => { scope[g] = true; });
    next[scopeId] = scope;
  }
  await storageSetObject(SCOPE_KEY, next);
}

// Marks every currently-known guid in each given scope as read — the full known set, not just
// whatever a caller happens to have loaded or displayed, since a scope's true guid set only ever
// lives here. A scope is a scope regardless of whether it's a flat feed key or a topic id (see
// SCOPE_KEY above); this is the one "mark this scope fully read" operation both use, at whatever
// granularity the caller needs (a single topic, every topic in a forum, or a flat feed's own
// scope). Returns what was marked per scope, so the caller can reflect it without re-deriving.
export async function markScopesRead(scopeIds: string[]): Promise<Record<string, string[]>> {
  const all = await getAllScopes();
  const updates: Record<string, string[]> = {};
  for (const scopeId of scopeIds) {
    updates[scopeId] = Object.keys(all[scopeId] ?? {});
  }
  await markGuidsRead(updates);
  return updates;
}

// Read-only, pure, synchronous view over an already-loaded scope — no I/O, no stored mutable
// state. Deliberately inert: two independently-loaded views of the same scope each mutating and
// saving on their own would race, so all mutation goes through markScopesSeen/markGuidsRead above.
export interface TopicReadView {
  hasUnread: boolean;
  isRead(guid: string): boolean;
}

export function viewScope(guids: Record<string, boolean>): TopicReadView {
  return {
    hasUnread: Object.values(guids).some((read) => !read),
    isRead: (guid) => guids[guid] ?? false,
  };
}

// Single-scope convenience wrappers, for call sites that only ever touch one scope at a time
// (e.g. tapping a single post). Each does its own getAllScopes() read — fine for a genuine
// one-off, but never call these inside a loop over many items/topics/scopes; batch-load
// getAllScopes()/getAllTopicSubscriptions() once and use viewScope()/direct lookups instead (see
// detectForumUnread below for the pattern). That per-item-vs-batched distinction is the entire
// difference between a cheap detection pass and one that re-reads the whole store per item.
export async function markRead(scopeId: string, guid: string): Promise<void> {
  await markGuidsRead({ [scopeId]: [guid] });
}

export async function markAllRead(scopeId: string, guids: string[]): Promise<void> {
  await markGuidsRead({ [scopeId]: guids });
}

export async function isRead(scopeId: string, guid: string): Promise<boolean> {
  const all = await getAllScopes();
  return viewScope(all[scopeId] ?? {}).isRead(guid);
}

export async function hasUnread(scopeId: string): Promise<boolean> {
  const all = await getAllScopes();
  return viewScope(all[scopeId] ?? {}).hasUnread;
}

// Flat feeds (Members Area) don't need the boundary-walk detection below — there's no per-item
// fetch cost to save, the whole window is already in hand from one request, so every fetch just
// records its entire window as seen.
export async function markFlatFeedSeen(feedKey: FeedKey, items: RssItem[]): Promise<void> {
  await markScopesSeen({ [feedKey]: items.map((i) => i.guid) });
}

// The single entry point callers outside this file (ForumFeed) should use to refresh one topic's
// content: fetches, then performs whichever scope update the result implies — clear on deletion,
// mark-seen otherwise — so the view layer never touches scope_guids directly, only reacts to the
// items/deleted it gets back. Not used by detectForumUnread's own deep-dive below, which batches
// many topics' scope writes into a single call for efficiency; this is for the single-topic,
// immediate-write case (an expanded topic's fetch, or a manual expand).
export async function updateTopic(topic: Topic, feedKey: FeedKey): Promise<TopicFeedResult> {
  const fetched = await fetchTopicFeed(topic, feedKey);
  if (fetched.deleted) {
    await clearScope(topic.id);
  } else {
    await markScopesSeen({ [topic.id]: fetched.items.map((i) => i.guid) });
  }
  return fetched;
}

// Per-topic hasUnread for every subscribed topic in a forum, derived purely from already-loaded
// data — no I/O, no topic-registry read. A topic id is always "{forumKey}:{slug}" (see
// generateTopicId), so which topics belong to this forum is already answerable from scopes' own
// keys; silenced topics are excluded entirely, matching detectForumUnread's own treatment of them.
export function topicUnreadForForum(
  forumKey: FeedKey,
  scopes: Record<string, Record<string, boolean>>,
  subs: Record<string, boolean>
): Record<string, boolean> {
  const prefix = `${forumKey}:`;
  const result: Record<string, boolean> = {};
  for (const scopeId of Object.keys(scopes)) {
    if (!scopeId.startsWith(prefix)) continue;
    if (!(subs[scopeId] ?? true)) continue; // silenced — excluded, not just falsey
    result[scopeId] = viewScope(scopes[scopeId]).hasUnread;
  }
  return result;
}

// Whether a feed currently has any unread content, from an already-loaded scopes/subs snapshot —
// no I/O, so both FeedContext's per-feed badge derivation and any other caller needing the same
// yes/no answer share one definition of "unread" instead of each computing it their own way
// depending on whether the feed happens to be flat or topic-based. A flat feed has exactly one
// scope (itself); a topic-based forum's answer is "any non-silenced topic has unread" — a flat
// feed with sub-feeds set true would be a caller error, not something this silently guesses at.
export function feedHasUnread(
  feedKey: FeedKey,
  hasSubFeeds: boolean,
  scopes: Record<string, Record<string, boolean>>,
  subs: Record<string, boolean>
): boolean {
  if (!hasSubFeeds) return viewScope(scopes[feedKey] ?? {}).hasUnread;
  return Object.values(topicUnreadForForum(feedKey, scopes, subs)).some(Boolean);
}

function itemTopicId(forumKey: FeedKey, item: RssItem): string | null {
  const slug = extractTopicSlugFromLink(item.link);
  return slug ? generateTopicId(forumKey, slug) : null;
}

// Detects which topics in a forum have unread posts, without fetching every subscribed topic's
// own feed on every pass. Relies on a completeness proof: the bbPress RSS feed reliably returns
// items newest-first (the Cloudflare Worker backend already depends on this same guarantee).
// Walking newest-to-oldest, skipping silenced topics entirely (no lookup, no tracking — "newest"
// effectively means "newest item from a subscribed topic"):
//   - if the newest considered item is already known, nothing changed since the last check;
//   - if a known item is hit before the window is exhausted, everything collected before it is
//     provably the complete set of new posts across the forum — attribute directly via slug, no
//     per-topic fetch needed;
//   - if the whole window is exhausted without hitting a known item, completeness can't be
//     proven (the app was closed a long time, or a silenced topic dominated the window), so every
//     subscribed topic gets its own feed fetched directly instead. All concurrently (Promise.all),
//     so this costs one round-trip's worth of wall-clock time regardless of topic count, not one
//     per topic — an earlier cap at the 10 most-recently-active topics saved nothing in latency
//     and only meant a cold/inactive topic could go undetected indefinitely.
// Returns hasUnread for every topic touched this pass; a topic absent from the result provably
// didn't change and keeps whatever value the caller already has for it.
export async function detectForumUnread(
  forumKey: FeedKey,
  topLevelItems: RssItem[] // newest-first, guaranteed by bbPress
): Promise<Record<string, boolean>> {
  if (topLevelItems.length === 0) return {};

  const allScopes = await getAllScopes(); // one read for the whole pass
  const subsMap = await getAllTopicSubscriptions(); // one read for the whole pass
  const isSubscribed = (topicId: string) => subsMap[topicId] ?? true;

  const seenUpdates: Record<string, string[]> = {};
  let complete = false;
  for (const item of topLevelItems) {
    const topicId = itemTopicId(forumKey, item);
    if (!topicId) continue; // no slug on link — can't attribute, skip
    if (!isSubscribed(topicId)) continue; // silenced — skip, don't track
    const scope = allScopes[topicId] ?? {};
    if (item.guid in scope) {
      complete = true;
      break;
    }
    (seenUpdates[topicId] ??= []).push(item.guid);
  }

  const touchedTopicIds = new Set(Object.keys(seenUpdates));

  if (!complete) {
    // Window exhausted without a known boundary — can't prove nothing was missed. Fall back to
    // every subscribed topic (see comment above on why this isn't bounded). A topic confirmed
    // deleted by fetchTopicFeed is removed from storage outright, so it's already absent from
    // getTopicsForForum's results — no separate filter needed here for that case.
    const candidates = (await getTopicsForForum(forumKey))
      .filter((t: Topic) => isSubscribed(t.id));

    const dives = await Promise.all(candidates.map(async (topic) => {
      const fetched = await fetchTopicFeed(topic, forumKey);
      return { topicId: topic.id, guids: fetched.items.map((i) => i.guid), deleted: fetched.deleted };
    }));
    for (const { topicId, guids, deleted } of dives) {
      if (deleted) {
        // The dive runs after the top-level fetch, so the main walk can only have speculatively
        // staged this exact topicId if the topic was deleted for real in the gap before the dive
        // — a narrow race, not worth preventing, but recovery must still be clean: undo the
        // staging, not just skip adding to it, or the closing markScopesSeen call below would
        // immediately resurrect a guid into the scope clearScope just wiped.
        await clearScope(topicId);
        delete seenUpdates[topicId];
        touchedTopicIds.delete(topicId);
        continue;
      }
      seenUpdates[topicId] = [...(seenUpdates[topicId] ?? []), ...guids];
      touchedTopicIds.add(topicId);
    }
  }

  await markScopesSeen(seenUpdates); // single write for the entire pass

  // Post-write hasUnread for every touched topic, computed purely in-memory from the pre-write
  // scopes (allScopes) plus what this pass just inserted — markScopesSeen never overwrites an
  // already-known guid, so replaying that same "add if absent" rule here needs no second read.
  const result: Record<string, boolean> = {};
  for (const topicId of touchedTopicIds) {
    const merged = { ...(allScopes[topicId] ?? {}) };
    (seenUpdates[topicId] ?? []).forEach((g) => { if (!(g in merged)) merged[g] = false; });
    result[topicId] = viewScope(merged).hasUnread;
  }
  // Deliberately not reported for a deleted topic (see the `continue` above) — this return value
  // is a partial "what changed" record, not a source of truth for badge state. FeedContext derives
  // badge state fresh from the model (topicUnreadForForum) rather than merging this incrementally,
  // so a topic's absence here doesn't leave stale state anywhere.
  return result;
}
