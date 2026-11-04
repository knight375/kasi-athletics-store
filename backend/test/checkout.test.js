import assert from "node:assert/strict";
import test from "node:test";
import { calculateOrder } from "../src/catalog.js";
import worker, { CheckoutStartError, createCheckoutOrder, isPaymentsReady } from "../src/index.js";
import { createMemoryStore } from "./helpers.js";

test("prices are calculated from the server catalog, not client price fields", () => {
  const quote = calculateOrder([
    { productId: "campus-hoodie", quantity: 2, size: "M", color: "Black", price: 1 },
    {
      productId: "custom-low",
      quantity: 1,
      colors: { body: "#e8d8bb", laces: "#f7f7f2", sole: "#282b2a" },
      price: 1
    }
  ]);

  assert.equal(quote.total, 9300);
  assert.equal(quote.items[0].unitPrice, 2400);
  assert.equal(quote.items[1].unitPrice, 4500);
});

test("rejects unknown products, invalid quantities, sizes, and custom colors", () => {
  assert.throws(() => calculateOrder([{ productId: "not-a-product", quantity: 1 }]), /Unknown product/);
  assert.throws(() => calculateOrder([{ productId: "campus-cap", quantity: 0, size: "One size", color: "Olive" }]), /quantity/);
  assert.throws(() => calculateOrder([{ productId: "court-runner", quantity: 1, size: "XXL", color: "Sand" }]), /size/);
  assert.throws(() => calculateOrder([{
    productId: "custom-low",
    quantity: 1,
    colors: { body: "#ffffff", laces: "#f7f7f2", sole: "#282b2a" }
  }]), /color/);
});

test("successful checkout leaves an order pending until its webhook", async () => {
  const store = createMemoryStore();
  const result = await createCheckoutOrder({
    id: "order-1",
    items: [{ productId: "campus-cap", quantity: 1, size: "One size", color: "Olive" }],
    store,
    redirectUrl: "https://knight375.github.io/kasi-athletics-store/#checkout-return/order-1",
    now: () => 1,
    createProviderCheckout: async payload => {
      assert.equal(payload.amount, 765);
      assert.equal(payload.currency, "KES");
      assert.equal(payload.apiRef, "order-1");
      return { id: "invoice-1", url: "https://sandbox.intasend.com/checkout/invoice-1/express/", paid: true };
    }
  });

  assert.equal(result.status, "pending");
  assert.equal(store.orders.get("order-1").status, "pending");
  assert.equal(store.orders.get("order-1").amountMinor, 76500);
});

test("payments stay disabled unless the sandbox key and explicit readiness flag are present", async () => {
  const baseConfig = {
    DB: {},
    STOREFRONT_URL: "https://knight375.github.io/kasi-athletics-store/",
    INTASEND_PUBLIC_API_KEY: "ISPubKey_test_example",
    INTASEND_WEBHOOK_CHALLENGE: "a-very-long-test-challenge-value"
  };
  assert.equal(isPaymentsReady({ ...baseConfig, PAYMENTS_ENABLED: "false" }), false);
  assert.equal(isPaymentsReady({
    ...baseConfig,
    PAYMENTS_ENABLED: "true",
    INTASEND_PUBLIC_API_KEY: "ISPubKey_live_example"
  }), false);
  assert.equal(isPaymentsReady({ ...baseConfig, PAYMENTS_ENABLED: "true" }), true);

  const response = await worker.fetch(new Request("https://worker.example/api/config"), {});
  assert.deepEqual(await response.json(), { paymentsEnabled: false });
});

test("checkout API returns unavailable without merchant configuration", async () => {
  const response = await worker.fetch(new Request("https://worker.example/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ productId: "campus-cap", quantity: 1, size: "One size", color: "Olive" }] })
  }), {});
  const result = await response.json();

  assert.equal(response.status, 503);
  assert.equal(result.error, "payments_unavailable");
  assert.match(result.message, /No payment was taken/);
});

test("checkout provider failure leaves the order unpaid and failed", async () => {
  const store = createMemoryStore();

  await assert.rejects(createCheckoutOrder({
    id: "order-failed",
    items: [{ productId: "campus-cap", quantity: 1, size: "One size", color: "Olive" }],
    store,
    redirectUrl: "https://knight375.github.io/kasi-athletics-store/",
    now: () => 2,
    createProviderCheckout: async () => { throw new Error("provider unavailable"); }
  }), CheckoutStartError);

  assert.equal(store.orders.get("order-failed").status, "checkout_failed");
});

test("rejects checkout URLs outside the IntaSend sandbox", async () => {
  const store = createMemoryStore();

  await assert.rejects(createCheckoutOrder({
    id: "order-bad-url",
    items: [{ productId: "campus-cap", quantity: 1, size: "One size", color: "Olive" }],
    store,
    redirectUrl: "https://knight375.github.io/kasi-athletics-store/",
    now: () => 3,
    createProviderCheckout: async () => ({ id: "invoice-1", url: "https://evil.example/checkout" })
  }), CheckoutStartError);

  assert.equal(store.orders.get("order-bad-url").status, "checkout_failed");
});
