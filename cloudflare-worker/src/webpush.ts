import { buildPushPayload, type PushMessage, type PushSubscription, type VapidKeys } from '@block65/webcrypto-web-push';

export type { PushSubscription, VapidKeys };

export interface WebPushResult {
  ok: boolean;
  // True on HTTP 404 or 410. The Web Push protocol uses these to signal that a subscription no
  // longer exists. Callers must prune the registration when gone is true, or expired
  // subscriptions accumulate forever.
  gone: boolean;
}

// Encrypts and signs one message for one subscriber. The Web Push protocol has no bulk-send
// endpoint — every subscriber requires its own encrypted payload and its own request.
export async function sendWebPush(subscription: PushSubscription, message: PushMessage, vapid: VapidKeys): Promise<WebPushResult> {
  const payload = await buildPushPayload(message, subscription, vapid);
  const res = await fetch(subscription.endpoint, payload);
  return { ok: res.ok, gone: res.status === 404 || res.status === 410 };
}
