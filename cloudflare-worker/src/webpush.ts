import { buildPushPayload, type PushMessage, type PushSubscription, type VapidKeys } from '@block65/webcrypto-web-push';

export type { PushSubscription, VapidKeys };

export interface WebPushResult {
  ok: boolean;
  // true on HTTP 404/410 — the protocol's standard "this subscription no longer exists" signal.
  // Callers must prune the registration on gone:true or expired subscriptions accumulate forever.
  gone: boolean;
}

// Encrypts and signs one message for one subscriber (Web Push has no bulk-send endpoint, unlike
// Expo's push API — this is an inherent protocol constraint, not a design choice made here).
export async function sendWebPush(subscription: PushSubscription, message: PushMessage, vapid: VapidKeys): Promise<WebPushResult> {
  const payload = await buildPushPayload(message, subscription, vapid);
  const res = await fetch(subscription.endpoint, payload);
  return { ok: res.ok, gone: res.status === 404 || res.status === 410 };
}
