CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'payment_failed', 'checkout_failed')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (currency = 'KES'),
  items_json TEXT NOT NULL,
  provider_invoice_id TEXT UNIQUE,
  checkout_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE webhook_events (
  event_key TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  provider_invoice_id TEXT NOT NULL,
  provider_state TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE INDEX webhook_events_order_id_idx ON webhook_events(order_id);
