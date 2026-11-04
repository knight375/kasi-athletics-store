import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../src/index.js";
import { createD1Store } from "../src/store.js";
import { createSQLiteD1 } from "./helpers.js";

const origin = "https://knight375.github.io";

function createAuthFixture() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(readFileSync(new URL("../migrations/0001_orders.sql", import.meta.url), "utf8"));
  database.exec(readFileSync(new URL("../migrations/0002_accounts.sql", import.meta.url), "utf8"));
  const db = createSQLiteD1(database);
  const env = {
    DB: db,
    STOREFRONT_URL: `${origin}/kasi-athletics-store/`,
    PAYMENTS_ENABLED: "false"
  };
  return { database, db, env };
}

function authRequest(path, { method = "GET", body, cookie, ip = "198.51.100.42" } = {}) {
  const headers = { Origin: origin };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  headers["CF-Connecting-IP"] = ip;
  return new Request(`https://worker.example${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

test("signup stores only a salted password hash and issues an opaque secure session cookie", async () => {
  const { database, db, env } = createAuthFixture();
  const response = await worker.fetch(authRequest("/api/auth/register", {
    method: "POST",
    body: {
      name: "Amina Njeri",
      email: "Amina@example.com",
      phone: "+254 712 345 678",
      password: "a-strong-password"
    }
  }), env);

  assert.equal(response.status, 201);
  const { user } = await response.json();
  assert.deepEqual(Object.keys(user).sort(), ["email", "id", "name", "phone"]);
  assert.equal(user.email, "amina@example.com");
  assert.equal(user.phone, "+254712345678");

  const setCookie = response.headers.get("Set-Cookie");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=None/);
  assert.match(setCookie, /Path=\/api/);
  const cookie = setCookie.split(";")[0];
  const rawToken = cookie.slice("ka_session=".length);
  const sessionRow = database.prepare("SELECT token_hash, expires_at, created_at FROM account_sessions").get();
  const storedPassword = database.prepare("SELECT password_salt, password_hash FROM accounts").get();
  assert.notEqual(storedPassword.password_hash, "a-strong-password");
  assert.equal(storedPassword.password_hash.length, 64);
  assert.notEqual(storedPassword.password_salt, "a-strong-password");
  assert.notEqual(sessionRow.token_hash, rawToken);
  assert.ok(sessionRow.expires_at - sessionRow.created_at >= 30 * 24 * 60 * 60 * 1000 - 1000);

  const sessionResponse = await worker.fetch(authRequest("/api/auth/session", { cookie }), env);
  assert.deepEqual((await sessionResponse.json()).user, user);
  assert.equal(sessionResponse.headers.get("Access-Control-Allow-Credentials"), "true");
  assert.equal(sessionResponse.headers.get("Access-Control-Allow-Origin"), origin);

  const savedState = {
    cart: [{ productId: "court-runner", size: "41", color: "Blue", quantity: 2 }],
    wishlist: ["court-runner"]
  };
  const saveResponse = await worker.fetch(authRequest("/api/account/state", {
    method: "PUT",
    cookie,
    body: savedState
  }), env);
  assert.equal(saveResponse.status, 200);
  assert.deepEqual((await saveResponse.json()).state, savedState);

  const invalidStateResponse = await worker.fetch(authRequest("/api/account/state", {
    method: "PUT",
    cookie,
    body: { cart: [{ productId: "court-runner", size: "XXL", color: "Blue", quantity: 1 }], wishlist: [] }
  }), env);
  assert.equal(invalidStateResponse.status, 400);

  const stateResponse = await worker.fetch(authRequest("/api/account/state", { cookie }), env);
  assert.deepEqual((await stateResponse.json()).state, savedState);

  const logoutResponse = await worker.fetch(authRequest("/api/auth/logout", {
    method: "POST",
    cookie,
    body: {}
  }), env);
  assert.match(logoutResponse.headers.get("Set-Cookie"), /Max-Age=0/);
  assert.equal((await (await worker.fetch(authRequest("/api/auth/session", { cookie }), env)).json()).user, null);

  const duplicate = await worker.fetch(authRequest("/api/auth/register", {
    method: "POST",
    body: {
      name: "Different Name",
      email: "AMINA@example.com",
      phone: "0712345678",
      password: "another-strong-password"
    }
  }), env);
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).message, "Unable to create an account with those details.");
  database.close();
});

test("signup validates profile fields on the Worker", async () => {
  const { database, env } = createAuthFixture();
  const response = await worker.fetch(authRequest("/api/auth/register", {
    method: "POST",
    body: {
      name: "Amina",
      email: "not-an-email",
      phone: "x",
      password: "short"
    }
  }), env);

  assert.equal(response.status, 400);
  assert.equal((await response.json()).field, "email");
  assert.equal(database.prepare("SELECT count(*) AS count FROM accounts").get().count, 0);
  database.close();
});

test("login failures are generic, rate limited per email and IP, and valid login works", async () => {
  const { database, env } = createAuthFixture();
  const registration = await worker.fetch(authRequest("/api/auth/register", {
    method: "POST",
    body: {
      name: "Amina Njeri",
      email: "amina@example.com",
      phone: "0712345678",
      password: "a-strong-password"
    }
  }), env);
  assert.equal(registration.status, 201);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const failed = await worker.fetch(authRequest("/api/auth/login", {
      method: "POST",
      ip: "198.51.100.91",
      body: { email: "amina@example.com", password: "incorrect-password" }
    }), env);
    assert.equal(failed.status, 401);
    assert.equal((await failed.json()).message, "Email or password is incorrect.");
  }
  const limited = await worker.fetch(authRequest("/api/auth/login", {
    method: "POST",
    ip: "198.51.100.91",
    body: { email: "amina@example.com", password: "a-strong-password" }
  }), env);
  assert.equal(limited.status, 429);

  const login = await worker.fetch(authRequest("/api/auth/login", {
    method: "POST",
    ip: "198.51.100.92",
    body: { email: "AMINA@example.com", password: "a-strong-password" }
  }), env);
  assert.equal(login.status, 200);
  assert.deepEqual((await login.json()).user.email, "amina@example.com");
  assert.match(login.headers.get("Set-Cookie"), /HttpOnly/);

  const blockedOrigin = await worker.fetch(new Request("https://worker.example/api/auth/login", {
    method: "POST",
    headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
    body: JSON.stringify({ email: "amina@example.com", password: "a-strong-password" })
  }), env);
  assert.equal(blockedOrigin.status, 403);
  database.close();
});

test("account API rejects unauthenticated and cross-site state changes", async () => {
  const { database, env } = createAuthFixture();
  const unauthenticated = await worker.fetch(authRequest("/api/account/state", {
    method: "PUT",
    body: { cart: [], wishlist: [] }
  }), env);
  assert.equal(unauthenticated.status, 401);

  const missingOrigin = await worker.fetch(new Request("https://worker.example/api/auth/logout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  }), env);
  assert.equal(missingOrigin.status, 403);
  database.close();
});
