import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export function createMemoryStore() {
  const orders = new Map();
  const events = new Set();
  return {
    orders,
    events,
    async createOrder(order) {
      orders.set(order.id, { ...order, providerInvoiceId: null, checkoutUrl: null });
    },
    async saveCheckout(orderId, invoiceId, checkoutUrl, updatedAt) {
      const order = orders.get(orderId);
      Object.assign(order, { providerInvoiceId: invoiceId, checkoutUrl, updatedAt });
    },
    async markCheckoutFailed(orderId, updatedAt) {
      const order = orders.get(orderId);
      if (order?.status === "pending") Object.assign(order, { status: "checkout_failed", updatedAt });
    },
    async findOrder(orderId) {
      return orders.get(orderId) || null;
    },
    async recordWebhook(event) {
      if (events.has(event.eventKey)) return false;
      events.add(event.eventKey);
      const order = orders.get(event.orderId);
      if (event.nextStatus === "paid") order.status = "paid";
      else if (event.nextStatus === "payment_failed" && order.status === "pending") {
        order.status = "payment_failed";
      }
      order.updatedAt = event.receivedAt;
      return true;
    }
  };
}

export function createSQLiteD1(database) {
  const bindStatement = (sql, values) => ({
    async first() {
      return database.prepare(sql).get(...values) || null;
    },
    async run() {
      const result = database.prepare(sql).run(...values);
      return { meta: { changes: Number(result.changes) } };
    }
  });

  return {
    prepare(sql) {
      return { bind: (...values) => bindStatement(sql, values) };
    },
    async batch(statements) {
      database.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
  };
}

export function createTestDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(awaitReadMigration("0001_orders.sql"));
  database.exec(awaitReadMigration("0002_accounts.sql"));
  return database;
}

function awaitReadMigration(name) {
  return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}
