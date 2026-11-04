export function createD1Store(db) {
  return {
    async createOrder(order) {
      await db.prepare(
        `INSERT INTO orders
          (id, status, amount_minor, currency, items_json, created_at, updated_at)
         VALUES (?, 'pending', ?, 'KES', ?, ?, ?)`
      ).bind(
        order.id,
        order.amountMinor,
        JSON.stringify(order.items),
        order.createdAt,
        order.createdAt
      ).run();
    },

    async saveCheckout(orderId, invoiceId, checkoutUrl, updatedAt) {
      await db.prepare(
        `UPDATE orders
         SET provider_invoice_id = ?, checkout_url = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`
      ).bind(invoiceId, checkoutUrl, updatedAt, orderId).run();
    },

    async markCheckoutFailed(orderId, updatedAt) {
      await db.prepare(
        `UPDATE orders
         SET status = 'checkout_failed', updated_at = ?
         WHERE id = ? AND status = 'pending'`
      ).bind(updatedAt, orderId).run();
    },

    async findOrder(orderId) {
      const row = await db.prepare(
        `SELECT id, status, amount_minor, currency, provider_invoice_id, created_at, updated_at
         FROM orders WHERE id = ?`
      ).bind(orderId).first();

      if (!row) return null;
      return {
        id: row.id,
        status: row.status,
        amountMinor: row.amount_minor,
        currency: row.currency,
        providerInvoiceId: row.provider_invoice_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    },

    async recordWebhook(event) {
      const results = await db.batch([
        db.prepare(
          `INSERT OR IGNORE INTO webhook_events
            (event_key, order_id, provider_invoice_id, provider_state, received_at)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(
          event.eventKey,
          event.orderId,
          event.invoiceId,
          event.state,
          event.receivedAt
        ),
        db.prepare(
          `UPDATE orders
           SET status = CASE
             WHEN ? = 'paid' THEN 'paid'
             WHEN status = 'paid' THEN 'paid'
             WHEN ? = 'payment_failed' AND status = 'pending' THEN 'payment_failed'
             ELSE status
           END,
           updated_at = ?
           WHERE id = ?
             AND provider_invoice_id = ?
             AND EXISTS (SELECT 1 FROM webhook_events WHERE event_key = ? AND order_id = ?)`
        ).bind(
          event.nextStatus,
          event.nextStatus,
          event.receivedAt,
          event.orderId,
          event.invoiceId,
          event.eventKey,
          event.orderId
        )
      ]);

      return results[0]?.meta?.changes === 1;
    },

    async findAccountByEmail(email) {
      return db.prepare(
        `SELECT id, email, name, phone, password_salt, password_hash
         FROM accounts WHERE email = ? COLLATE NOCASE`
      ).bind(email).first();
    },

    async createAccount(account) {
      await db.batch([
        db.prepare(
          `INSERT INTO accounts (id, email, name, phone, password_salt, password_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          account.id,
          account.email,
          account.name,
          account.phone,
          account.passwordSalt,
          account.passwordHash,
          account.createdAt
        ),
        db.prepare(
          "INSERT INTO account_state (account_id, cart_json, wishlist_json, updated_at) VALUES (?, '[]', '[]', ?)"
        ).bind(account.id, account.createdAt)
      ]);
    },

    async incrementAuthRateLimit(bucketHash, now, windowMs) {
      await db.prepare(
        "DELETE FROM auth_rate_limits WHERE window_started_at <= ?"
      ).bind(now - windowMs).run();
      return db.prepare(
        `INSERT INTO auth_rate_limits (bucket_hash, attempts, window_started_at)
         VALUES (?, 1, ?)
         ON CONFLICT(bucket_hash) DO UPDATE SET
           attempts = CASE WHEN window_started_at + ? <= ? THEN 1 ELSE attempts + 1 END,
           window_started_at = CASE WHEN window_started_at + ? <= ? THEN ? ELSE window_started_at END
         RETURNING attempts`
      ).bind(bucketHash, now, windowMs, now, windowMs, now, now).first();
    },

    async createAccountSession(tokenHash, accountId, expiresAt, createdAt) {
      await db.batch([
        db.prepare("DELETE FROM account_sessions WHERE expires_at <= ?").bind(createdAt),
        db.prepare(
          "INSERT INTO account_sessions (token_hash, account_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
        ).bind(tokenHash, accountId, expiresAt, createdAt)
      ]);
    },

    async findAccountSession(tokenHash, now) {
      return db.prepare(
        `SELECT a.id, a.email, a.name, a.phone
         FROM account_sessions s
         JOIN accounts a ON a.id = s.account_id
         WHERE s.token_hash = ? AND s.expires_at > ?`
      ).bind(tokenHash, now).first();
    },

    async deleteAccountSession(tokenHash) {
      await db.prepare("DELETE FROM account_sessions WHERE token_hash = ?").bind(tokenHash).run();
    },

    async getAccountState(accountId) {
      const row = await db.prepare(
        "SELECT cart_json, wishlist_json FROM account_state WHERE account_id = ?"
      ).bind(accountId).first();
      return row
        ? { cart: JSON.parse(row.cart_json), wishlist: JSON.parse(row.wishlist_json) }
        : { cart: [], wishlist: [] };
    },

    async saveAccountState(accountId, state, updatedAt) {
      await db.prepare(
        `INSERT INTO account_state (account_id, cart_json, wishlist_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           cart_json = excluded.cart_json,
           wishlist_json = excluded.wishlist_json,
           updated_at = excluded.updated_at`
      ).bind(
        accountId,
        JSON.stringify(state.cart),
        JSON.stringify(state.wishlist),
        updatedAt
      ).run();
    }
  };
}
