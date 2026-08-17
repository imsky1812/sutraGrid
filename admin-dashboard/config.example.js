// Copy this file to admin-dashboard/config.js and fill in real values.
// config.js is gitignored — never commit it.
//
// Note: a browser-side Maps key is always visible to anyone who loads the page.
// The protection is not secrecy, it is restriction: in Google Cloud Console set
// an HTTP-referrer restriction and limit the key to the Maps JavaScript API.
window.SUTRA_CONFIG = {
    // Google Maps JavaScript API key, referrer-restricted.
    MAPS_API_KEY: 'your-maps-js-api-key',

    // Must match OPERATOR_KEY in backend-mock/.env.
    OPERATOR_KEY: 'change-me-operator-key',

    // host:port of the mock backend.
    BACKEND_HOST: 'localhost:3000'
};
