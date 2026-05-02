import * as SecureStore from 'expo-secure-store';

const BASE_URL = 'https://logicalinvestor.net';
const LOGIN_URL = 'https://logicalinvestor.net/backend/';
const TOKEN_KEY = 'feed_token';

async function fetchFeedToken(cookies: string): Promise<string> {
  const response = await fetch(`${BASE_URL}/my-feed-url`, {
    headers: { Cookie: cookies },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch feed token: ${response.status}`);
  }

  const text = await response.text();
  const match = text.match(/feed_token=([a-zA-Z0-9_-]+)/);

  if (!match) {
    throw new Error('Feed token not found in response');
  }

  return match[1];
}

export async function login(username: string, password: string): Promise<void> {
  // Step 1: Get the login nonce from WordPress
  const loginPageResponse = await fetch(`${LOGIN_URL}`);
  const cookies = loginPageResponse.headers.get('set-cookie') ?? '';

  // Step 2: POST credentials
  const formData = new URLSearchParams();
  formData.append('log', username);
  formData.append('pwd', password);
  formData.append('wp-submit', 'Log in');
  formData.append('user-cookie', '1');
  formData.append('fusion_login_box', 'true');
  formData.append('_wp_http_referer', '/member-login/');
  formData.append('redirect_to', BASE_URL);

  const loginResponse = await fetch(`${LOGIN_URL}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookies,
      Referer: LOGIN_URL,
    },
    body: formData.toString(),
    redirect: 'manual',
  });

  const authCookies = loginResponse.headers.get('set-cookie') ?? '';
  const finalUrl = loginResponse.headers.get('location') ?? '';

  if (finalUrl.includes('member-login')) {
    throw new Error('Login failed — check your credentials');
  }

  // Step 3: Fetch the feed token using the auth cookies
  const token = await fetchFeedToken(authCookies);

  // Step 4: Store it securely
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function getToken(): Promise<string | null> {
  return await SecureStore.getItemAsync(TOKEN_KEY);
}

export async function logout(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

export async function isAuthenticated(): Promise<boolean> {
  const token = await getToken();
  return token !== null;
}