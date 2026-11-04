import { calculateOrder, normalizeAccountState, OrderValidationError } from "./catalog.js";
import {
  AuthValidationError,
  findSession,
  getSessionToken,
  loginAccount,
  registerAccount,
  revokeSession,
  SESSION_LIFETIME_SECONDS
} from "./auth.js";
import { createD1Store } from "./store.js";

const MAX_REQUEST_BYTES = 16 * 1024;
const INTA_SEND_CHECKOUT_URL = "https://api.intasend.com/api/v1/checkout/";
const allowedProviderStates = new Set([
  "PENDING", "PROCESSING", "RETRY", "PARTIAL", "COMPLETE", "FAILED", "CANCELED"
]);

export class CheckoutStartError extends Error {
  constructor() {
    super("Could not start IntaSend checkout.");
    this.name = "CheckoutStartError";
  }
}

export function parseAmountToMinorUnits(value) {
  if (typeof value !== "string") return null;
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] || "").padEnd(2, "0"));
  const amount = whole * 100 + fraction;
  return Number.isSafeInteger(amount) ? amount : null;
}

export function verifyWebhookChallenge(received, expected) {
  if (typeof received !== "string" || typeof expected !== "string" || expected.length === 0) {
    return false;
  }

  let difference = received.length ^ expected.length;
  const length = Math.max(received.length, expected.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (received.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSandboxCheckoutUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "sandbox.intasend.com";
  } catch {
    return false;
  }
}

function isValidStorefrontUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname.endsWith("/");
  } catch {
    return false;
  }
}

export function isPaymentsReady(env) {
  return env.PAYMENTS_ENABLED === "true"
    && typeof env.INTASEND_PUBLIC_API_KEY === "string"
    && env.INTASEND_PUBLIC_API_KEY.startsWith("ISPubKey_test_")
    && typeof env.INTASEND_WEBHOOK_CHALLENGE === "string"
    && env.INTASEND_WEBHOOK_CHALLENGE.length >= 24
    && Boolean(env.DB)
    && isValidStorefrontUrl(env.STOREFRONT_URL);
}

export async function createCheckoutOrder({
  items,
  store,
  createProviderCheckout,
  redirectUrl,
  id = crypto.randomUUID(),
  now = Date.now
}) {
  const quote = calculateOrder(items);
  const createdAt = now();
  await store.createOrder({
    id,
    status: "pending",
    amountMinor: quote.total * 100,
    currency: "KES",
    items: quote.items,
    createdAt
  });

  let checkout;
  try {
    checkout = await createProviderCheckout({
      amount: quote.total,
      currency: "KES",
      apiRef: id,
      redirectUrl
    });
    if (!checkout || typeof checkout.id !== "string" || !isSandboxCheckoutUrl(checkout.url)) {
      throw new Error("IntaSend returned an invalid sandbox checkout.");
    }
  } catch (error) {
    await store.markCheckoutFailed(id, now());
    console.error("IntaSend checkout initiation failed.", error instanceof Error ? error.message : "Unknown provider error.");
    if (error instanceof CheckoutStartError) throw error;
    throw new CheckoutStartError();
  }

  await store.saveCheckout(id, checkout.id, checkout.url, now());
  return { orderId: id, checkoutUrl: checkout.url, status: "pending" };
}

export async function applyCollectionWebhook(payload, { challenge, store, now = Date.now }) {
  if (!isRecord(payload) || !verifyWebhookChallenge(payload.challenge, challenge)) {
    return { status: 401, error: "invalid_challenge" };
  }
  if (payload.topic !== "collection_event"
    || typeof payload.invoice_id !== "string"
    || typeof payload.api_ref !== "string"
    || typeof payload.state !== "string"
    || !allowedProviderStates.has(payload.state)
    || typeof payload.updated_at !== "string"
    || !Number.isFinite(Date.parse(payload.updated_at))
    || payload.updated_at.length > 64) {
    return { status: 400, error: "invalid_event" };
  }

  const order = await store.findOrder(payload.api_ref);
  if (!order) return { status: 404, error: "order_not_found" };
  if (order.providerInvoiceId !== payload.invoice_id
    || order.currency !== payload.currency
    || parseAmountToMinorUnits(payload.value) !== order.amountMinor) {
    return { status: 400, error: "payment_details_mismatch" };
  }

  const nextStatus = payload.state === "COMPLETE"
    ? "paid"
    : ["FAILED", "CANCELED"].includes(payload.state)
      ? "payment_failed"
      : "pending";
  const eventKey = `${payload.invoice_id}:${payload.state}:${payload.updated_at}`;
  const inserted = await store.recordWebhook({
    eventKey,
    orderId: order.id,
    invoiceId: payload.invoice_id,
    state: payload.state,
    nextStatus,
    receivedAt: now()
  });

  return { status: 200, accepted: true, duplicate: !inserted };
}

async function readJson(request, maxBytes = MAX_REQUEST_BYTES) {
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { error: "request_too_large" };
  }
  const reader = request.body?.getReader();
  if (!reader) return { error: "invalid_json" };
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      return { error: "request_too_large" };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const raw = new TextDecoder().decode(bytes);
  try {
    return { value: JSON.parse(raw) };
  } catch (error) {
    if (error instanceof SyntaxError) return { error: "invalid_json" };
    throw error;
  }
}

async function createIntaSendCheckout(env, requestData) {
  const response = await fetch(INTA_SEND_CHECKOUT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-IntaSend-Public-API-Key": env.INTASEND_PUBLIC_API_KEY
    },
    body: JSON.stringify({
      amount: requestData.amount,
      currency: requestData.currency,
      api_ref: requestData.apiRef,
      unique_api_ref: true,
      host: new URL(env.STOREFRONT_URL).origin,
      redirect_url: requestData.redirectUrl
    }),
    signal: AbortSignal.timeout(10_000)
  });

  if (!response.ok) throw new CheckoutStartError();
  let data;
  try {
    data = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) throw new CheckoutStartError();
    throw error;
  }
  return data;
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  return new Response(JSON.stringify(data), {
    status,
    headers
  });
}

function allowedOrigin(env) {
  try {
    return new URL(env.STOREFRONT_URL).origin;
  } catch {
    return null;
  }
}

function addCors(request, env, response) {
  const origin = request.headers.get("Origin");
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set("Vary", "Origin");
  headers.set("Access-Control-Allow-Origin", allowedOrigin(env) || "");
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, X-Requested-With");
  return new Response(response.body, { status: response.status, headers });
}

function authCookie(token, maxAge = SESSION_LIFETIME_SECONDS) {
  return `ka_session=${encodeURIComponent(token)}; Path=/api; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=None`;
}

function authRequestAllowed(request, env) {
  return request.headers.get("Origin") === allowedOrigin(env)
    && request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() === "application/json";
}

function accountRequired(request, env, store, requireJson = false) {
  if (!store) return jsonResponse({ error: "account_unavailable", message: "Account service is unavailable." }, 503);
  if (request.headers.get("Origin") !== allowedOrigin(env)
    || (requireJson && request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json")) {
    return jsonResponse({ error: "origin_not_allowed" }, 403);
  }
  return null;
}

async function handleAuth(request, env, store, pathname) {
  const mutating = request.method === "POST";
  if (mutating && !authRequestAllowed(request, env)) {
    return jsonResponse({ error: "origin_not_allowed" }, 403);
  }
  if (!store) return jsonResponse({ error: "account_unavailable", message: "Account service is unavailable." }, 503);

  if (pathname === "/api/auth/session" && request.method === "GET") {
    const user = await findSession(getSessionToken(request), { store });
    return jsonResponse({ user });
  }

  if (pathname === "/api/auth/logout" && request.method === "POST") {
    await revokeSession(getSessionToken(request), store);
    return jsonResponse({ success: true }, 200, {
      "Set-Cookie": authCookie("", 0)
    });
  }

  if (pathname === "/api/auth/register" || pathname === "/api/auth/login") {
    if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
    const body = await readJson(request);
    if (body.error) return jsonResponse({ error: body.error }, 400);
    try {
      const session = pathname.endsWith("/register")
        ? await registerAccount(body.value, { store })
        : await loginAccount(body.value, {
          store,
          ipAddress: request.headers.get("CF-Connecting-IP") || "unknown"
        });
      return jsonResponse({ user: session.user }, pathname.endsWith("/register") ? 201 : 200, {
        "Set-Cookie": authCookie(session.token)
      });
    } catch (error) {
      if (error instanceof AuthValidationError) {
        return jsonResponse({
          error: error.field === "credentials" ? "login_failed" : "invalid_account",
          message: error.message,
          field: error.field
        }, error.status);
      }
      throw error;
    }
  }

  return jsonResponse({ error: "not_found" }, 404);
}

async function handleAccountState(request, env, store) {
  const denied = accountRequired(request, env, store, request.method === "PUT");
  if (denied) return denied;
  const user = await findSession(getSessionToken(request), { store });
  if (!user) return jsonResponse({ error: "unauthorized" }, 401);

  if (request.method === "GET") {
    return jsonResponse({ state: await store.getAccountState(user.id) });
  }
  if (request.method !== "PUT") return jsonResponse({ error: "method_not_allowed" }, 405);

  const body = await readJson(request);
  if (body.error) return jsonResponse({ error: body.error }, 400);
  try {
    const state = normalizeAccountState(body.value);
    await store.saveAccountState(user.id, state, Date.now());
    return jsonResponse({ state });
  } catch (error) {
    if (error instanceof OrderValidationError) {
      return jsonResponse({ error: "invalid_account_state", message: error.message }, 400);
    }
    throw error;
  }
}

async function handleCheckout(request, env, store) {
  if (!isPaymentsReady(env)) {
    return jsonResponse({
      error: "payments_unavailable",
      message: "Secure checkout is not configured. No payment was taken."
    }, 503);
  }

  const body = await readJson(request);
  if (body.error) return jsonResponse({ error: body.error }, 400);
  if (!isRecord(body.value)) return jsonResponse({ error: "invalid_request" }, 400);

  let redirectUrl;
  try {
    redirectUrl = new URL(env.STOREFRONT_URL);
    if (!isValidStorefrontUrl(env.STOREFRONT_URL)) throw new Error("Invalid storefront URL.");
  } catch {
    return jsonResponse({ error: "payments_unavailable" }, 503);
  }
  const orderId = crypto.randomUUID();
  redirectUrl.hash = `checkout-return/${orderId}`;

  try {
    const result = await createCheckoutOrder({
      items: body.value.items,
      store,
      redirectUrl: redirectUrl.toString(),
      createProviderCheckout: data => createIntaSendCheckout(env, data),
      id: orderId
    });
    return jsonResponse(result, 201);
  } catch (error) {
    if (error instanceof CheckoutStartError) {
      return jsonResponse({
        error: "checkout_failed",
        message: "Checkout could not be started. No payment was taken."
      }, 502);
    }
    if (error instanceof OrderValidationError) {
      return jsonResponse({ error: "invalid_cart", message: error.message }, 400);
    }
    throw error;
  }
}

async function route(request, env) {
  const url = new URL(request.url);
  const store = env.DB ? createD1Store(env.DB) : null;

  if (request.method === "GET" && url.pathname === "/api/config") {
    return jsonResponse({ paymentsEnabled: isPaymentsReady(env) });
  }

  if (url.pathname.startsWith("/api/auth/")) {
    return handleAuth(request, env, store, url.pathname);
  }

  if (url.pathname === "/api/account/state") {
    return handleAccountState(request, env, store);
  }

  if (request.method === "POST" && url.pathname === "/api/checkout") {
    return handleCheckout(request, env, store);
  }

  if (request.method === "GET" && /^\/api\/orders\/[0-9a-f-]{36}$/i.test(url.pathname)) {
    if (!store) return jsonResponse({ error: "order_status_unavailable" }, 503);
    const orderId = url.pathname.slice("/api/orders/".length);
    const order = await store.findOrder(orderId);
    if (!order) return jsonResponse({ error: "order_not_found" }, 404);
    return jsonResponse({
      orderId: order.id,
      status: order.status,
      amountMinor: order.amountMinor,
      currency: order.currency
    });
  }

  if (request.method === "POST" && url.pathname === "/api/webhooks/intasend") {
    if (!store) return jsonResponse({ error: "webhook_unavailable" }, 503);
    const body = await readJson(request, 32 * 1024);
    if (body.error) return jsonResponse({ error: body.error }, 400);
    const result = await applyCollectionWebhook(body.value, {
      challenge: env.INTASEND_WEBHOOK_CHALLENGE,
      store
    });
    return jsonResponse(result.status === 200
      ? { received: result.accepted, duplicate: result.duplicate }
      : { error: result.error }, result.status);
  }

  return jsonResponse({ error: "not_found" }, 404);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const configuredOrigin = allowedOrigin(env);
    if (origin && origin !== configuredOrigin) return jsonResponse({ error: "origin_not_allowed" }, 403);

    if (request.method === "OPTIONS") {
      if (!origin || origin !== configuredOrigin) return jsonResponse({ error: "origin_not_allowed" }, 403);
      return addCors(request, env, new Response(null, { status: 204 }));
    }

    return addCors(request, env, await route(request, env));
  }
};
