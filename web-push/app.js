// All API calls below use relative paths. This page and the API are always served by the same
// Worker, so a relative path always resolves correctly: production, local wrangler dev, or a
// dev tunnel pointed at either. This breaks only if the page and the API are ever served from
// different origins (a split deployment). That isn't the case today, and isn't planned.

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

const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
if (isIos && !isStandalone) iosNote.style.display = 'block';

for (const radio of form.querySelectorAll('input[name="filter"]')) {
  radio.addEventListener('change', () => {
    lengthFields.hidden = radio.form.filter.value !== 'length';
  });
}

if ('serviceWorker' in navigator) {
  // Relative, unlike the API calls below. sw.js is served alongside this page itself, wherever
  // that ends up being, not from the Worker's API domain. A relative path also scopes the
  // service worker to just this directory instead of the whole host. That matters if this page
  // ever lands under a subdirectory of a larger site.
  navigator.serviceWorker.register('./sw.js').catch((err) => {
    statusEl.textContent = `Service worker registration failed: ${err.message}`;
  });
}

// Only a same-origin request (this page served from logicalinvestor.net itself) can read
// /my-feed-url without CORS, using the visitor's existing WordPress session cookie.
// authService.ts does the same extraction in the RN app. A cross-origin fetch, such as one
// from the Worker's own domain, would be blocked by the browser. This gate avoids sending a
// request that would always fail.
if (location.hostname === 'logicalinvestor.net') {
  fetch('/my-feed-url', { credentials: 'same-origin' })
    .then((res) => res.text())
    .then((html) => {
      const match = html.match(/feed_token=([a-zA-Z0-9_-]+)/);
      if (match) document.getElementById('feed-token').value = match[1];
    })
    .catch(() => {}); // Not logged in, or the page shape changed. The user can still paste the token manually.
}

// PushManager.subscribe() requires the VAPID key as a raw Uint8Array. The server hands out a
// base64url string instead. This is the standard conversion every Web Push client needs.
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
    const vapidKey = await fetch('/vapid-public-key').then((res) => res.text());
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
    }

    setStatus('Registering…');
    const results = await Promise.all(channels.map((channel) =>
      fetch('/register', {
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
    const res = await fetch('/test-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: lastRegistration.subscription, channel: lastRegistration.channels[0], feed_token: lastRegistration.feedToken }),
    });
    setStatus(res.ok ? 'Test notification queued — check for it in a few seconds.' : `Test notification failed (HTTP ${res.status}).`);
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
    // Unconditionally unregisters all three channels. lastRegistration is in-memory only and is
    // lost on reload. It only reflects the most recent submission, so a channel selection
    // change across separate submissions could leave it incomplete. /unregister is a no-op for
    // a channel this subscription was never registered for, so clearing all three is always
    // safe.
    await Promise.all(['members', 'stock', 'options'].map((channel) =>
      fetch('/unregister', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: lastRegistration.subscription, channel }),
      })
    ));
    // Also tears down the browser's own subscription. Otherwise it stays registered with the
    // push service (Apple, Google, or Mozilla) after the server has already forgotten it.
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
