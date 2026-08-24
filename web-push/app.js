const form = document.getElementById('register-form');
const statusEl = document.getElementById('status');
const submitBtn = document.getElementById('submit-btn');
const unsubscribeBtn = document.getElementById('unsubscribe-btn');
const testBtn = document.getElementById('test-btn');
const iosNote = document.getElementById('ios-note');
const lengthFields = document.getElementById('length-fields');

// Set after a successful /register call, so the test/unsubscribe buttons can replay the same
// (subscription, channels, feed_token) without the user re-entering anything.
let lastRegistration = null;

// The API always lives on the Worker's own domain, regardless of where this page itself is
// served from. When the page IS served by the Worker (production workers.dev, local wrangler
// dev, or a dev tunnel pointed at either), relative paths already resolve there correctly, so
// API_BASE stays empty — only logicalinvestor.net (a different origin entirely) needs the
// absolute URL. Mirrors the /my-feed-url origin gate below.
const WORKER_URL = 'https://logicalinvestor-push.logicalinvestor.workers.dev';
const API_BASE = location.hostname === 'logicalinvestor.net' ? WORKER_URL : '';

const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
if (isIos && !isStandalone) iosNote.style.display = 'block';

for (const radio of form.querySelectorAll('input[name="filter"]')) {
  radio.addEventListener('change', () => {
    lengthFields.hidden = radio.form.filter.value !== 'length';
  });
}

if ('serviceWorker' in navigator) {
  // Relative, unlike the API calls below — sw.js is served alongside this page itself, from
  // wherever that ends up being, not from the Worker's API domain. A relative path also scopes
  // the service worker to just this directory (not the whole host), which matters if this page
  // ever lands under a subdirectory of a larger site rather than at its root.
  navigator.serviceWorker.register('./sw.js').catch((err) => {
    statusEl.textContent = `Service worker registration failed: ${err.message}`;
  });
}

// Only same-origin (this page served from logicalinvestor.net itself) can read /my-feed-url
// without CORS, using the visitor's existing WordPress session cookie — same extraction
// authService.ts does in the RN app. Cross-origin (e.g. the Worker's own domain), this fetch
// would be blocked by the browser, so it's gated to avoid a guaranteed-failing request.
if (location.hostname === 'logicalinvestor.net') {
  fetch('/my-feed-url', { credentials: 'same-origin' })
    .then((res) => res.text())
    .then((html) => {
      const match = html.match(/feed_token=([a-zA-Z0-9_-]+)/);
      if (match) document.getElementById('feed-token').value = match[1];
    })
    .catch(() => {}); // not logged in, or page shape changed — user can still paste it manually
}

// PushManager.subscribe() requires the VAPID key as a raw Uint8Array, not the base64url string
// the server hands out — this is the standard conversion every Web Push client needs.
function urlBase64ToUint8Array(base64Url) {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

function setStatus(text) {
  statusEl.textContent = text;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    setStatus('This browser does not support web push notifications.');
    return;
  }

  const feedToken = document.getElementById('feed-token').value.trim();
  const channels = [...form.querySelectorAll('input[name="channel"]:checked')].map((el) => el.value);
  const filter = form.filter.value;
  const authors = document.getElementById('authors').value.split(',').map((a) => a.trim()).filter(Boolean);
  const minLength = parseInt(document.getElementById('min-length').value, 10) || 0;

  if (!feedToken) { setStatus('Feed token is required.'); return; }
  if (channels.length === 0) { setStatus('Choose at least one forum.'); return; }

  submitBtn.disabled = true;
  try {
    setStatus('Requesting notification permission…');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      setStatus('Notification permission was not granted.');
      return;
    }

    setStatus('Subscribing…');
    const registration = await navigator.serviceWorker.ready;
    const vapidKey = await fetch(`${API_BASE}/vapid-public-key`).then((res) => res.text());
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
    }

    setStatus('Registering…');
    const results = await Promise.all(channels.map((channel) =>
      fetch(`${API_BASE}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: subscription.toJSON(), channel, filter, authors, minLength, feed_token: feedToken }),
      }).then((res) => ({ channel, ok: res.ok }))
    ));

    const failed = results.filter((r) => !r.ok).map((r) => r.channel);
    const succeeded = results.filter((r) => r.ok).map((r) => r.channel);
    setStatus(failed.length === 0
      ? 'Notifications enabled for: ' + channels.join(', ')
      : `Failed to register: ${failed.join(', ')} (check your feed token and subscription access)`);

    if (succeeded.length > 0) {
      lastRegistration = { subscription: subscription.toJSON(), channels: succeeded, feedToken };
      unsubscribeBtn.hidden = false;
      testBtn.hidden = false;
    }
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    submitBtn.disabled = false;
  }
});

testBtn.addEventListener('click', async () => {
  if (!lastRegistration) return;
  testBtn.disabled = true;
  try {
    setStatus('Sending test notification…');
    const res = await fetch(`${API_BASE}/test-push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: lastRegistration.subscription, channel: lastRegistration.channels[0], feed_token: lastRegistration.feedToken }),
    });
    setStatus(res.ok ? 'Test notification sent — check for it now.' : `Test notification failed (HTTP ${res.status}).`);
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    testBtn.disabled = false;
  }
});

unsubscribeBtn.addEventListener('click', async () => {
  if (!lastRegistration) return;
  unsubscribeBtn.disabled = true;
  try {
    setStatus('Disabling notifications…');
    // Unconditionally unregister every channel — not just the ones from the most recent
    // successful registration. lastRegistration is in-memory only (lost on reload) and only
    // reflects the last submission, so it can't be trusted as "everything this subscription is
    // currently registered for" if channel selection ever changed across separate submissions.
    // /unregister is a no-op for a channel this subscription was never registered for, so
    // clearing all three unconditionally is always correct, never harmful.
    await Promise.all(['members', 'stock', 'options'].map((channel) =>
      fetch(`${API_BASE}/unregister`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: lastRegistration.subscription, channel }),
      })
    ));
    // ...and tear down the browser's own subscription, so it's not left dangling with the push
    // service (Apple/Google/Mozilla) after the server no longer has any record of it.
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) await subscription.unsubscribe();

    setStatus('Notifications disabled.');
    lastRegistration = null;
    unsubscribeBtn.hidden = true;
    testBtn.hidden = true;
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    unsubscribeBtn.disabled = false;
  }
});
