const PASSWORD_ITERATIONS = 210_000;
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPT_LIMIT = 5;
const DUMMY_SALT = "AAAAAAAAAAAAAAAAAAAAAA==";
const encoder = new TextEncoder();

export class AuthValidationError extends Error {
  constructor(field, message, status = 400) {
    super(message);
    this.name = "AuthValidationError";
    this.field = field;
    this.status = status;
  }
}

function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value) {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

function toHex(bytes) {
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value) {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

async function derivePassword(password, saltBase64) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt: fromBase64(saltBase64),
    iterations: PASSWORD_ITERATIONS
  }, key, 256);
  return toHex(new Uint8Array(bits));
}

function equalHash(left, right) {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function normalizeProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthValidationError("form", "Enter your account details.");
  }
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const email = typeof value.email === "string" ? value.email.trim().toLowerCase() : "";
  const phone = typeof value.phone === "string" ? value.phone.trim() : "";
  const password = typeof value.password === "string" ? value.password : "";

  if (name.length < 1 || name.length > 80) {
    throw new AuthValidationError("name", "Enter your name (up to 80 characters).");
  }
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AuthValidationError("email", "Enter a valid email address.");
  }
  if (!/^\+?[0-9][0-9\s()-]{6,19}$/.test(phone)) {
    throw new AuthValidationError("phone", "Enter a valid phone number, including country code if needed.");
  }
  if (password.length < 8 || password.length > 128) {
    throw new AuthValidationError("password", "Password must be 8–128 characters.");
  }

  return { name, email, phone: phone.replace(/[^\d+]/g, ""), password };
}

function publicAccount(account) {
  return {
    id: account.id,
    name: account.name,
    email: account.email,
    phone: account.phone
  };
}

async function createSession(account, store, now) {
  const rawToken = toBase64(crypto.getRandomValues(new Uint8Array(32)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  const createdAt = now();
  await store.createAccountSession(
    await sha256(rawToken),
    account.id,
    createdAt + SESSION_LIFETIME_MS,
    createdAt
  );
  return { token: rawToken, user: publicAccount(account) };
}

export async function registerAccount(value, { store, now = Date.now }) {
  const profile = normalizeProfile(value);
  const salt = toBase64(crypto.getRandomValues(new Uint8Array(16)));
  const passwordHash = await derivePassword(profile.password, salt);
  const account = {
    id: crypto.randomUUID(),
    email: profile.email,
    name: profile.name,
    phone: profile.phone,
    passwordSalt: salt,
    passwordHash,
    createdAt: now()
  };

  try {
    await store.createAccount(account);
  } catch (error) {
    if (error?.message?.includes("UNIQUE constraint failed: accounts.email")) {
      throw new AuthValidationError("email", "Unable to create an account with those details.", 409);
    }
    throw error;
  }

  return createSession(account, store, now);
}

export async function loginAccount(value, { store, ipAddress = "unknown", now = Date.now }) {
  const email = typeof value?.email === "string" ? value.email.trim().toLowerCase() : "";
  const password = typeof value?.password === "string" ? value.password : "";
  const validEmail = email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!validEmail || password.length < 1 || password.length > 128) {
    throw new AuthValidationError("credentials", "Email or password is incorrect.", 401);
  }

  const bucketHash = await sha256(`${email}\0${ipAddress}`);
  const rate = await store.incrementAuthRateLimit(bucketHash, now(), LOGIN_WINDOW_MS);
  if (rate.attempts > LOGIN_ATTEMPT_LIMIT) {
    throw new AuthValidationError("credentials", "Too many attempts. Try again later.", 429);
  }
  const account = await store.findAccountByEmail(email);
  const candidateHash = await derivePassword(password, account?.password_salt || DUMMY_SALT);
  const matches = equalHash(candidateHash, account?.password_hash || "0".repeat(64));
  if (!account || !matches) {
    throw new AuthValidationError("credentials", "Email or password is incorrect.", 401);
  }

  return createSession(account, store, now);
}

export async function findSession(token, { store, now = Date.now }) {
  if (!token || token.length > 128) return null;
  const account = await store.findAccountSession(await sha256(token), now());
  return account ? publicAccount(account) : null;
}

export async function revokeSession(token, store) {
  if (token && token.length <= 128) await store.deleteAccountSession(await sha256(token));
}

export function getSessionToken(request) {
  const cookie = request.headers.get("Cookie") || "";
  const item = cookie.split(";").map(value => value.trim()).find(value => value.startsWith("ka_session="));
  if (!item) return "";
  try {
    return decodeURIComponent(item.slice("ka_session=".length));
  } catch {
    return "";
  }
}

export const SESSION_LIFETIME_SECONDS = SESSION_LIFETIME_MS / 1000;
