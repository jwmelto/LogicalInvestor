import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendWebPush, type PushSubscription, type VapidKeys } from './webpush';

// Throwaway test-only VAPID and client key material — distinct from any real deployed keys,
// generated the same way (uncompressed P-256 point / raw scalar, both base64url) that
// buildPushPayload() requires.
const vapid: VapidKeys = {
  subject: 'mailto:test@example.com',
  publicKey: 'BPCnUQ9J_eoysTmL_P7DlsBAv5zaU2aylMaMl2VzAKzk_FbMuvA20mC8cjW6EwDXa6oAgFRf_FDHGE6N5OZZzp0',
  privateKey: 'id36_WQR8FiP-75gk_Na8OgU9YsWSZWcMxCicgWTfTo',
};

const subscription: PushSubscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/fake-endpoint-id',
  expirationTime: null,
  keys: {
    p256dh: 'BELwtddmVvbvOEHadf6IA9Jj2Gx2u6K9Yoj-0TOzGPDJWfQbUprGpFpfOKvULdsyl9m5LwdBLqG6t9zUajeGN8A',
    auth: 'wUSvE5FxCS7VqmXHVW79FQ',
  },
};

const message = { data: { title: 'New post', body: 'hello' } };

beforeEach(() => { vi.restoreAllMocks(); });

describe('sendWebPush', () => {
  it('posts the encrypted payload to the subscription endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendWebPush(subscription, message, vapid);

    expect(result).toEqual({ ok: true, gone: false });
    expect(fetchMock).toHaveBeenCalledWith(subscription.endpoint, expect.objectContaining({ method: 'post' }));
  });

  it.each([404, 410])('reports gone:true on HTTP %d (subscription no longer exists)', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status }));

    const result = await sendWebPush(subscription, message, vapid);

    expect(result).toEqual({ ok: false, gone: true });
  });

  it('reports gone:false on other failures — a transient error must not prune the subscription', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const result = await sendWebPush(subscription, message, vapid);

    expect(result).toEqual({ ok: false, gone: false });
  });
});
