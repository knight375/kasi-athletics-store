import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createD1Store } from "../src/store.js";
import { createSQLiteD1 } from "./helpers.js";

test("D1 order and webhook statements persist state idempotently", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(new URL("../migrations/0001_orders.sql", import.meta.url), "utf8"));
  database.exec(readFileSync(new URL("../migrations/0002_accounts.sql", import.meta.url), "utf8"));
  const store = createD1Store(createSQLiteD1(database));
  await store.createOrder({
    id: "order-1",
    amountMinor: 390000,
    items: [{ productId: "court-runner", quantity: 1 }],
    createdAt: 1
  });
  await store.saveCheckout("order-1", "invoice-1", "https://sandbox.intasend.com/checkout/invoice-1/express/", 2);

  const order = await store.findOrder("order-1");
  assert.equal(order.status, "pending");
  assert.equal(order.amountMinor, 390000);
  assert.equal(order.providerInvoiceId, "invoice-1");

  const completedEvent = {
    eventKey: "invoice-1:COMPLETE:2026-10-01T10:00:00+03:00",
    orderId: "order-1",
    invoiceId: "invoice-1",
    state: "COMPLETE",
    nextStatus: "paid",
    receivedAt: 3
  };
  assert.equal(await store.recordWebhook(completedEvent), true);
  assert.equal(await store.recordWebhook(completedEvent), false);
  assert.equal((await store.findOrder("order-1")).status, "paid");

  assert.equal(await store.recordWebhook({
    ...completedEvent,
    eventKey: "invoice-1:FAILED:2026-10-01T09:00:00+03:00",
    state: "FAILED",
    nextStatus: "payment_failed",
    receivedAt: 4
  }), true);
  assert.equal((await store.findOrder("order-1")).status, "paid");

  database.close();
});
