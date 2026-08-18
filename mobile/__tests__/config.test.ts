const URL_KEY = 'EXPO_PUBLIC_SUPABASE_URL';
const ANON_KEY = 'EXPO_PUBLIC_SUPABASE_ANON_KEY';

describe('config', () => {
  const original: Record<string, string | undefined> = {
    [URL_KEY]: process.env[URL_KEY],
    [ANON_KEY]: process.env[ANON_KEY],
  };

  // Individual keys are restored rather than reassigning process.env wholesale:
  // replacing the object detaches it from the real environment and later
  // deletes stop having any effect, which shows up as tests that mysteriously
  // stop throwing after the first one.
  const set = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    set(URL_KEY, original[URL_KEY]);
    set(ANON_KEY, original[ANON_KEY]);
  });

  it('throws a named error when the Supabase URL is missing', () => {
    set(URL_KEY, undefined);
    set(ANON_KEY, 'key');
    expect(() => require('../src/config')).toThrow(new RegExp(URL_KEY));
  });

  it('throws a named error when the anon key is missing', () => {
    set(URL_KEY, 'https://example.supabase.co');
    set(ANON_KEY, undefined);
    expect(() => require('../src/config')).toThrow(new RegExp(ANON_KEY));
  });

  it('points at copying .env.example, so the fix is obvious', () => {
    set(URL_KEY, undefined);
    set(ANON_KEY, 'key');
    expect(() => require('../src/config')).toThrow(/\.env\.example/);
  });

  it('exposes url and key when both are set', () => {
    set(URL_KEY, 'https://example.supabase.co');
    set(ANON_KEY, 'anon-key');
    const { config } = require('../src/config');
    expect(config.supabaseUrl).toBe('https://example.supabase.co');
    expect(config.supabaseAnonKey).toBe('anon-key');
  });
});
