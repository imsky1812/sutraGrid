// Copy to admin-dashboard/config.js and fill in. config.js is gitignored.
//
// Both values are Supabase and both are publishable: the anon key is designed
// to be public and is constrained by row-level security. What an operator can
// actually see is decided by the `operators` table, not by this file.
//
// There is no maps key. Tiles come from OpenFreeMap, which needs no account.
window.SUTRA_CONFIG = {
    SUPABASE_URL: 'https://your-project-ref.supabase.co',
    SUPABASE_ANON_KEY: 'your-anon-key',
};
