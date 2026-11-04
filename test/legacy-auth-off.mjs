// Loaded by `npm test` (node --import). The older tests below call the API handlers
// without a board session, so they run with the Nov 2026 API sign-in check switched
// off and keep testing the business logic only. test/api-auth.test.mjs turns the check
// back on and tests it directly.
process.env.API_AUTH_ENFORCE ??= 'off';
