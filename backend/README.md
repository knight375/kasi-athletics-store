# IntaSend checkout backend

The storefront remains a static GitHub Pages site. This Cloudflare Worker stores order state in D1 and creates IntaSend-hosted checkout sessions. The browser sends product IDs and options only; the Worker calculates all prices from the shared root `catalog.json` and the fixed KES 4,500 custom-shoe price.

## Accounts and sessions

The Worker provides registration, login, logout, session lookup, and authenticated account shopping-state endpoints. Passwords are never stored in the browser or in plaintext: the Worker hashes them with PBKDF2-SHA-256 (210,000 iterations and a fresh 128-bit random salt). Session cookies contain opaque random tokens; D1 stores only their SHA-256 hashes and a 30-day expiry. Login attempts are limited to five per 15-minute window for a hashed normalized-email/IP pair. Account profile, cart variant selections, and wishlist are stored in D1; the browser retains guest cart state in memory and merges it with account cart state at sign-in. Existing orders are not associated with accounts, so the account page clearly reports that guest and WhatsApp orders are not linked.

The GitHub Pages storefront and Worker are different sites. Account requests therefore use credentialed CORS from the exact configured `STOREFRONT_URL`, and the session cookie uses `Secure; HttpOnly; SameSite=None` so browsers can send it on cross-site API requests. Some browsers or privacy settings block third-party cookies; a same-site custom domain/reverse proxy is the recommended production setup. Mutating account requests also require the exact configured `Origin`.

Password reset is not available because no email sender or identity provider is configured. The Forgot password link directs customers to Kasi support via WhatsApp; it does not pretend to send a reset email. No sample account or password is included. For local testing, from `backend/` run `npx wrangler d1 migrations apply kasi-athletics-orders --local`, then start the Worker with `npx wrangler dev --local --var STOREFRONT_URL:http://127.0.0.1:8000/ --port 8787`. Serve the repository root at `http://127.0.0.1:8000`, temporarily set the local storefront's `PAYMENTS_API_BASE` to `http://127.0.0.1:8787`, and create a disposable account through Sign up. Do not reuse a real password. This uses Wrangler's local D1 database and does not change remote services.

The authentication API is implemented here but is not deployed by this change. Until a separately approved Worker deployment includes the migration and routes, the configured public Worker will not provide account functionality.

## Product catalog

The root `catalog.json` is the shared source for storefront listings and Worker checkout validation. Each product defines its category, subcategory, gender, KES price, optional `salePrice`, description, tags, sizes, and 3–5 color variants (`name`, `hex`, and a local `image` path). To add a product, add a uniquely identified entry with the matching category and appropriate sizes, then run `node scripts/generate-product-images.mjs` from the repository root to create its local color-specific SVG placeholders and update the image paths. Prices and variant options are enforced by the Worker from this same file; never add browser-supplied prices as authoritative data.

Product images are intentionally generated placeholders rather than third-party or licensed product imagery. Payments remain disabled in `wrangler.toml`, and the storefront keeps its WhatsApp order-request option available.

## Local checks

From this directory, run `npm install` and `npm test`. The tests use Node's built-in test runner and do not call IntaSend or require credentials.

## Configuration required before sandbox checkout

1. Create a Cloudflare account and a D1 database, then replace the placeholder `database_id` in `wrangler.toml`.
2. Set `STOREFRONT_URL` to the complete HTTPS GitHub Pages URL, including its trailing slash. The Worker accepts browser API calls only from that exact origin.
3. Store the IntaSend sandbox publishable key as the Worker secret `INTASEND_PUBLIC_API_KEY` (for example with `npx wrangler secret put INTASEND_PUBLIC_API_KEY`).
4. In the IntaSend sandbox dashboard, add an HTTPS webhook pointing to `/api/webhooks/intasend`, subscribe to `collection_event`, and set a randomly generated challenge. Store the same challenge as the Worker secret `INTASEND_WEBHOOK_CHALLENGE` (for example with `npx wrangler secret put INTASEND_WEBHOOK_CHALLENGE`).
5. Account endpoints require the D1 migrations, including `0002_accounts.sql`. Keep `PAYMENTS_ENABLED=false`; account setup does not enable payments.
6. After the Worker is deployed, set `window.PAYMENTS_API_BASE` in the root `payments-config.js` to its HTTPS URL. The storefront keeps the payment button disabled if this endpoint is missing, unreachable, or reports payments unavailable.

The IntaSend checkout is created by the Worker with the server-calculated item subtotal in KES; delivery is arranged separately over WhatsApp. Customers enter payment details only on IntaSend's hosted page. A redirect back to the storefront never confirms payment: only a `collection_event` webhook with a matching challenge, invoice, order reference, amount, and currency can update an order to `paid`. Webhook event keys and state transitions are stored idempotently.

No merchant credentials, Cloudflare account, deployment, or production service changes are included here. Do not use live keys with this sandbox-only implementation.

Provider reference: [IntaSend hosted checkout](https://developers.intasend.com/guides/collections/checkout/) and [webhook challenge and collection events](https://developers.intasend.com/guides/webhooks/).
