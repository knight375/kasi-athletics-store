import assert from "node:assert/strict";
import test from "node:test";
import { applyCollectionWebhook, parseAmountToMinorUnits, verifyWebhookChallenge } from "../src/index.js";
import { createMemoryStore } from "./helpers.js";

const order = {
  id: "order-1",
  status: "pending",
  amountMinor: 390000,
  currency: "KES",
  providerInvoiceId: "invoice-1"
};
const payload = {
  topic: "collection_event",
  challenge: "a-very-long-test-challenge-value",
  invoice_id: "invoice-1",
  api_ref: "order-1",
  state: "COMPLETE",
  value: "3900.00",
  currency: "KES",
  updated_at: "2026-10-01T10:00:00+03:00"
};

test("parses provider decimal amounts without floating point arithmetic", () => {
  assert.equal(parseAmountToMinorUnits("3900.00"), 390000);
  assert.equal(parseAmountToMinorUnits("0.10"), 10);
  assert.equal(parseAmountToMinorUnits("1.234"), null);
  assert.equal(parseAmountToMinorUnits(3900), null);
});

test("webhook challenge comparison rejects missing or different values", () => {
  assert.equal(verifyWebhookChallenge(payload.challenge, payload.challenge), true);
  assert.equal(verifyWebhookChallenge("wrong", payload.challenge), false);
  assert.equal(verifyWebhookChallenge(undefined, payload.challenge), false);
});

test("only a verified, matching completion event marks an order paid once", async () => {
  const store = createMemoryStore();
  store.orders.set(order.id, { ...order });
  const dependencies = { challenge: payload.challenge, store, now: () => 10 };

  const first = await applyCollectionWebhook(payload, dependencies);
  const second = await applyCollectionWebhook(payload, dependencies);

  assert.deepEqual(first, { status: 200, accepted: true, duplicate: false });
  assert.deepEqual(second, { status: 200, accepted: true, duplicate: true });
  assert.equal(store.events.size, 1);
  assert.equal(store.orders.get(order.id).status, "paid");
});

test("invalid challenge, order reference, amount, or currency cannot mark an order paid", async () => {
  const store = createMemoryStore();
  store.orders.set(order.id, { ...order });

  const badChallenge = await applyCollectionWebhook({ ...payload, challenge: "wrong" }, {
    challenge: payload.challenge, store
  });
  const badAmount = await applyCollectionWebhook({ ...payload, value: "1.00" }, {
    challenge: payload.challenge, store
  });
  const badCurrency = await applyCollectionWebhook({ ...payload, currency: "USD" }, {
    challenge: payload.challenge, store
  });
  const badReference = await applyCollectionWebhook({ ...payload, api_ref: "other-order" }, {
    challenge: payload.challenge, store
  });

  assert.equal(badChallenge.status, 401);
  assert.equal(badAmount.error, "payment_details_mismatch");
  assert.equal(badCurrency.error, "payment_details_mismatch");
  assert.equal(badReference.status, 404);
  assert.equal(store.orders.get(order.id).status, "pending");
});

test("a late failed event never downgrades a paid order", async () => {
  const store = createMemoryStore();
  store.orders.set(order.id, { ...order, status: "paid" });
  const result = await applyCollectionWebhook({
    ...payload,
    state: "FAILED",
    updated_at: "2026-10-01T09:00:00+03:00"
  }, { challenge: payload.challenge, store, now: () => 11 });

  assert.equal(result.status, 200);
  assert.equal(store.orders.get(order.id).status, "paid");
});
