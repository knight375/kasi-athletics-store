CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE account_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX account_sessions_expiry_idx ON account_sessions(expires_at);

CREATE TABLE auth_rate_limits (
  bucket_hash TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  window_started_at INTEGER NOT NULL
);

CREATE INDEX auth_rate_limits_window_idx ON auth_rate_limits(window_started_at);

CREATE TABLE account_state (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  cart_json TEXT NOT NULL DEFAULT '[]',
  wishlist_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
