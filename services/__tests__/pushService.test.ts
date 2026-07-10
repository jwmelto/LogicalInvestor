jest.mock('expo-constants', () => ({ expoConfig: { extra: { eas: { projectId: 'test-project' }, workerUrl: 'https://test.worker.dev' } } }));
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  getExpoPushTokenAsync: jest.fn().mockResolvedValue({ data: 'ExponentPushToken[test]' }),
}));

let stored: Record<string, string> = {};
jest.mock('../storageService', () => ({
  storageGet: jest.fn((key: string) => Promise.resolve(stored[key] ?? null)),
  storageSet: jest.fn((key: string, value: string) => { stored[key] = value; return Promise.resolve(); }),
}));

// authService.ts pulls in expo-secure-store, which isn't transformable under this project's jest
// config; cut the chain before it gets there (same issue noted in notificationService.test.ts).
jest.mock('../authService', () => ({ getToken: jest.fn() }));

import { registerPushChannel } from '../pushService';

describe('registerPushChannel', () => {
  beforeEach(() => {
    stored = {};
    global.fetch = jest.fn();
  });

  it('returns true and persists the channel when the server confirms', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true });
    const ok = await registerPushChannel('membersArea', 'feed-token');
    expect(ok).toBe(true);
    expect(JSON.parse(stored['push_channels'])).toContain('members');
  });

  it('returns false and does not persist the channel when the server rejects', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false });
    const ok = await registerPushChannel('membersArea', 'feed-token');
    expect(ok).toBe(false);
    expect(stored['push_channels']).toBeUndefined();
  });

  it('returns false and does not persist the channel on a network error', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('offline'));
    const ok = await registerPushChannel('membersArea', 'feed-token');
    expect(ok).toBe(false);
    expect(stored['push_channels']).toBeUndefined();
  });
});

describe('pushService module-load guard', () => {
  it('throws when app.json extra.workerUrl is missing, in every environment', () => {
    jest.resetModules();
    jest.doMock('expo-constants', () => ({ expoConfig: { extra: { eas: { projectId: 'test-project' } } } }));
    expect(() => require('../pushService')).toThrow(/workerUrl/);
    jest.dontMock('expo-constants');
    jest.resetModules();
  });
});
