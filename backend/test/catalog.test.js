import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import products from "../../catalog.json" with { type: "json" };
import { calculateOrder } from "../src/catalog.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const categories = ["Footwear", "Clothing", "Accessories", "Campus Collection", "Kids"];

test("catalog keeps the original products and covers every requested shop category", () => {
  assert.deepEqual(products.slice(0, 6).map(product => product.id), [
    "campus-hoodie", "court-runner", "varsity-tee", "street-low", "campus-cap", "track-jacket"
  ]);
  assert.ok(products.length >= 30);
  assert.deepEqual([...new Set(products.map(product => product.category))].sort(), [...categories].sort());
  assert.ok(products.some(product => product.category === "Footwear" && product.subcategory === "Running shoes"));
  assert.ok(products.some(product => product.category === "Footwear" && product.subcategory === "Basketball shoes"));
  assert.ok(products.some(product => product.category === "Footwear" && product.subcategory === "Slides"));
  assert.ok(products.some(product => product.category === "Footwear" && product.subcategory === "Sandals"));
  assert.ok(products.some(product => product.category === "Clothing" && product.subcategory === "Leggings"));
  assert.ok(products.some(product => product.category === "Clothing" && product.subcategory === "Jackets"));
  assert.ok(products.some(product => product.category === "Accessories" && product.subcategory === "Backpacks"));
  assert.ok(products.some(product => product.category === "Accessories" && product.subcategory === "Sports bands"));
  assert.ok(products.some(product => product.category === "Campus Collection"));
  assert.ok(products.some(product => product.category === "Kids" && product.subcategory.startsWith("Kids running")));
  assert.ok(products.some(product => product.category === "Kids" && product.subcategory.startsWith("Kids football")));
  assert.ok(products.some(product => product.category === "Kids" && product.subcategory.startsWith("Kids ")));
});

test("every product has valid variants, category-aware sizes, and generated local images", async () => {
  for (const product of products) {
    assert.ok(product.id && product.name && product.subcategory, `${product.id} needs identity and subcategory`);
    assert.ok(categories.includes(product.category), `${product.id} has an unknown category`);
    assert.ok(["men", "women", "kids", "unisex"].includes(product.gender), `${product.id} needs a supported gender`);
    assert.ok(Number.isSafeInteger(product.price) && product.price > 0, `${product.id} needs a KES price`);
    assert.ok(product.description.length > 20, `${product.id} needs a short description`);
    assert.ok(Array.isArray(product.tags), `${product.id} needs tags`);
    assert.ok(product.colors.length >= 3 && product.colors.length <= 5, `${product.id} needs 3-5 colors`);
    assert.equal(new Set(product.colors.map(color => color.name)).size, product.colors.length);
    assert.equal(new Set(product.colors.map(color => color.hex)).size, product.colors.length);
    for (const color of product.colors) {
      assert.match(color.hex, /^#[0-9a-f]{6}$/i);
      assert.match(color.image, new RegExp(`^\\./images/products/${product.id}_[a-z0-9-]+\\.svg$`));
      await access(path.join(root, color.image.slice(2)));
    }
    if (product.category === "Footwear") assert.deepEqual(product.sizes, Array.from({ length: 11 }, (_, i) => String(i + 36)));
    if (product.category === "Accessories") assert.deepEqual(product.sizes, ["One size"]);
    if (product.category === "Clothing" || product.category === "Campus Collection") {
      assert.deepEqual(product.sizes, ["XS", "S", "M", "L", "XL", "XXL"]);
    }
    if (product.category === "Kids" && product.subcategory.includes("shoes") || product.category === "Kids" && product.subcategory.includes("boots")) {
      assert.deepEqual(product.sizes, ["28", "29", "30", "31", "32", "33", "34", "35"]);
    }
    if (product.salePrice !== undefined) {
      assert.ok(Number.isSafeInteger(product.salePrice) && product.salePrice > 0 && product.salePrice < product.price);
      assert.ok(product.tags.includes("Sale"));
    }
  }
});

test("checkout prices every catalog item server-side, including sale prices", () => {
  for (const product of products) {
    const item = {
      productId: product.id,
      quantity: 1,
      size: product.sizes[0],
      color: product.colors[0].name,
      price: 1
    };
    const { total, items } = calculateOrder([item]);
    const expectedPrice = product.salePrice ?? product.price;
    assert.equal(total, expectedPrice, `${product.id} should use the catalog price`);
    assert.equal(items[0].unitPrice, expectedPrice, `${product.id} should not trust a browser price`);
    assert.equal(items[0].color, product.colors[0].name);
    assert.equal(items[0].colorHex, product.colors[0].hex);
  }
});

test("checkout requires valid variants and only requires sizes for sized products", () => {
  const oneSizeProduct = products.find(product => product.id === "sports-water-bottle");
  assert.equal(calculateOrder([{
    productId: oneSizeProduct.id,
    quantity: 1,
    color: oneSizeProduct.colors[0].name
  }]).total, oneSizeProduct.price);

  assert.throws(() => calculateOrder([{
    productId: "kenya-home-jersey",
    quantity: 1,
    color: "Red / Green / Black"
  }]), /size/);
  assert.throws(() => calculateOrder([{
    productId: "kenya-home-jersey",
    quantity: 1,
    size: "S",
    color: "Unlisted"
  }]), /color/);
});
