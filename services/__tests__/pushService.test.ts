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
// config; cut the chain before it gets there.
jest.mock('../authService', () => ({ getToken: jest.fn() }));

import { registerPushChannel, getPushFilter, getPushAuthors, getPushMinLength, updatePushSettings, addPushAuthor, addAuthorToList } from '../pushService';
import { getToken } from '../authService';

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

  it('reads filter/authors/minLength from storage when called without explicit settings', async () => {
    stored['push_filter'] = 'length';
    stored['push_authors'] = JSON.stringify(['herman']);
    stored['push_min_length'] = '50';
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true });
    await registerPushChannel('membersArea', 'feed-token');
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body).toMatchObject({ filter: 'length', authors: ['herman'], minLength: 50, feed_token: 'feed-token' });
  });

  it('sends an explicit override instead of stored settings when provided', async () => {
    stored['push_filter'] = 'length';
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true });
    await registerPushChannel('membersArea', 'feed-token', { filter: 'members', authors: [], minLength: 0 });
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body).toMatchObject({ filter: 'members', authors: [], minLength: 0 });
  });
});

describe('getPushFilter / getPushAuthors / getPushMinLength', () => {
  beforeEach(() => { stored = {}; });

  it('default to actionable / [Sean] / 200 when nothing is stored', async () => {
    expect(await getPushFilter()).toBe('actionable');
    expect(await getPushAuthors()).toEqual(['Sean']);
    expect(await getPushMinLength()).toBe(200);
  });

  it('return stored values when present', async () => {
    stored['push_filter'] = 'members';
    stored['push_authors'] = JSON.stringify(['Sean', 'herman']);
    stored['push_min_length'] = '0';
    expect(await getPushFilter()).toBe('members');
    expect(await getPushAuthors()).toEqual(['Sean', 'herman']);
    expect(await getPushMinLength()).toBe(0);
  });
});

describe('updatePushSettings', () => {
  beforeEach(() => {
    stored = {};
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    (getToken as jest.Mock).mockResolvedValue('feed-token');
  });

  it('persists all three fields and re-registers every enrolled channel', async () => {
    stored['push_channels'] = JSON.stringify(['members', 'stock']);
    await updatePushSettings({ filter: 'length', authors: ['herman'], minLength: 0 });

    expect(stored['push_filter']).toBe('length');
    expect(JSON.parse(stored['push_authors'])).toEqual(['herman']);
    expect(stored['push_min_length']).toBe('0');

    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);
    const channels = calls.map(([, init]) => JSON.parse(init.body).channel).sort();
    expect(channels).toEqual(['members', 'stock']);
  });

  it('does nothing when there is no feed token (not logged in)', async () => {
    (getToken as jest.Mock).mockResolvedValue(null);
    await updatePushSettings({ filter: 'length', authors: [], minLength: 0 });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(stored['push_filter']).toBeUndefined();
  });

  it('does not persist and reports failure when any channel fails to confirm', async () => {
    stored['push_channels'] = JSON.stringify(['members', 'stock']);
    (global.fetch as jest.Mock).mockImplementation((_url: string, init: RequestInit) => {
      const channel = JSON.parse(init.body as string).channel;
      return Promise.resolve({ ok: channel === 'members' });
    });

    const confirmed = await updatePushSettings({ filter: 'length', authors: ['herman'], minLength: 0 });

    expect(confirmed).toBe(false);
    expect(stored['push_filter']).toBeUndefined();
  });

  it('reports success only once every channel confirms', async () => {
    stored['push_channels'] = JSON.stringify(['members', 'stock']);
    const confirmed = await updatePushSettings({ filter: 'length', authors: ['herman'], minLength: 0 });
    expect(confirmed).toBe(true);
  });
});

describe('addAuthorToList', () => {
  it('appends a trimmed new author', () => {
    expect(addAuthorToList(['Sean'], '  herman  ')).toEqual(['Sean', 'herman']);
  });

  it('returns the same array reference for empty/whitespace-only input', () => {
    const authors = ['Sean'];
    expect(addAuthorToList(authors, '   ')).toBe(authors);
  });

  it('returns the same array reference for a case-insensitive duplicate', () => {
    const authors = ['Sean'];
    expect(addAuthorToList(authors, 'sean')).toBe(authors);
  });
});

describe('addPushAuthor', () => {
  beforeEach(() => {
    stored = {};
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    (getToken as jest.Mock).mockResolvedValue('feed-token');
  });

  it('appends a new author to the stored list', async () => {
    stored['push_authors'] = JSON.stringify(['Sean']);
    await addPushAuthor('herman');
    expect(JSON.parse(stored['push_authors'])).toEqual(['Sean', 'herman']);
  });

  it('does not duplicate an author already present', async () => {
    stored['push_authors'] = JSON.stringify(['Sean', 'herman']);
    await addPushAuthor('herman');
    expect(JSON.parse(stored['push_authors'])).toEqual(['Sean', 'herman']);
    expect(global.fetch).not.toHaveBeenCalled(); // no change, no re-registration needed
  });

  it('does not duplicate an author already present under a different case', async () => {
    stored['push_authors'] = JSON.stringify(['Sean']);
    await addPushAuthor('sean');
    expect(JSON.parse(stored['push_authors'])).toEqual(['Sean']);
    expect(global.fetch).not.toHaveBeenCalled();
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
