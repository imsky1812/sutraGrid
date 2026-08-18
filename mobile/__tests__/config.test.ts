const URL_KEY = 'EXPO_PUBLIC_SUPABASE_URL';
const ANON_KEY = 'EXPO_PUBLIC_SUPABASE_ANON_KEY';

describe('config', () => {
  const original: Record<string, string | undefined> = {
    [URL_KEY]: process.env[URL_KEY],
    [ANON_KEY]: process.env[ANON_KEY],
  };

  // Individual keys are restored rather than reassigning process.env wholesale:
  // replacing the object detaches it from the real environment and later
  // deletes stop having any effect.
  const set = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  beforeEach(() => jest.resetModules());

  afterEach(() => {
    set(URL_KEY, original[URL_KEY]);
    set(ANON_KEY, original[ANON_KEY]);
  });

  // Importing must not throw: on a device that happens before React renders, so
  // it crashes with no message and nothing to diagnose from.
  it('does not throw when configuration is missing', () => {
    set(URL_KEY, undefined);
    set(ANON_KEY, undefined);
    expect(() => require('../src/config')).not.toThrow();
  });

  it('names a missing url', () => {
    set(URL_KEY, undefined);
    set(ANON_KEY, 'key');
    expect(require('../src/config').missingConfig).toEqual([URL_KEY]);
  });

  it('names a missing anon key', () => {
    set(URL_KEY, 'https://example.supabase.co');
    set(ANON_KEY, undefined);
    expect(require('../src/config').missingConfig).toEqual([ANON_KEY]);
  });

  it('names both when neither is set', () => {
    set(URL_KEY, undefined);
    set(ANON_KEY, undefined);
    expect(require('../src/config').missingConfig).toEqual([URL_KEY, ANON_KEY]);
  });

  it('reports nothing missing when both are set', () => {
    set(URL_KEY, 'https://example.supabase.co');
    set(ANON_KEY, 'anon-key');
    expect(require('../src/config').missingConfig).toEqual([]);
  });

  it('exposes url and key when both are set', () => {
    set(URL_KEY, 'https://example.supabase.co');
    set(ANON_KEY, 'anon-key');
    const { config } = require('../src/config');
    expect(config.supabaseUrl).toBe('https://example.supabase.co');
    expect(config.supabaseAnonKey).toBe('anon-key');
  });
});
