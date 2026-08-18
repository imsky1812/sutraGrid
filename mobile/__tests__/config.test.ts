describe('config', () => {
  const ORIGINAL = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it('throws a named error when the Supabase URL is missing', () => {
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'key';
    jest.resetModules();
    expect(() => require('../src/config')).toThrow(/EXPO_PUBLIC_SUPABASE_URL/);
  });

  it('throws a named error when the anon key is missing', () => {
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    jest.resetModules();
    expect(() => require('../src/config')).toThrow(/EXPO_PUBLIC_SUPABASE_ANON_KEY/);
  });

  it('points at copying .env.example, so the fix is obvious', () => {
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'key';
    jest.resetModules();
    expect(() => require('../src/config')).toThrow(/\.env\.example/);
  });

  it('exposes url and key when both are set', () => {
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
    jest.resetModules();
    const { config } = require('../src/config');
    expect(config.supabaseUrl).toBe('https://example.supabase.co');
    expect(config.supabaseAnonKey).toBe('anon-key');
  });
});
