import products from "../../catalog.json" with { type: "json" };

const productById = new Map(products.map(product => [product.id, product]));
const customColors = {
  body: ["#e8d8bb", "#282b2a", "#567c9e", "#e35d4e"],
  laces: ["#f7f7f2", "#282b2a", "#e9c866", "#e35d4e"],
  sole: ["#f7f7f2", "#282b2a", "#71866c", "#567c9e"]
};

export class OrderValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "OrderValidationError";
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateQuantity(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 10;
}

export function calculateOrder(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 20) {
    throw new OrderValidationError("Cart must contain between 1 and 20 item lines.");
  }

  const validatedItems = items.map(item => {
    if (!isRecord(item) || !validateQuantity(item.quantity)) {
      throw new OrderValidationError("Each cart line must have a valid quantity.");
    }

    if (item.productId === "custom-low") {
      if (!isRecord(item.colors)) throw new OrderValidationError("Custom shoe colors are required.");
      const colors = {};
      for (const part of Object.keys(customColors)) {
        const color = item.colors[part];
        if (!customColors[part].includes(color)) throw new OrderValidationError("Invalid custom shoe color.");
        colors[part] = color;
      }

      const unitPrice = 4500;
      return {
        productId: "custom-low",
        name: "Kasi Custom Low",
        quantity: item.quantity,
        colors,
        unitPrice,
        lineTotal: unitPrice * item.quantity
      };
    }

    const product = productById.get(item.productId);
    if (!product) throw new OrderValidationError("Unknown product.");

    const sizes = product.sizes;
    const oneSize = sizes.length === 1 && sizes[0] === "One size";
    if ((!oneSize && !sizes.includes(item.size)) || (oneSize && item.size && item.size !== "One size")) {
      throw new OrderValidationError("Select a valid size.");
    }
    const color = product.colors.find(variant => variant.name === item.color);
    if (!color) throw new OrderValidationError("Select a valid product color.");

    const unitPrice = product.salePrice ?? product.price;
    return {
      productId: product.id,
      name: product.name,
      quantity: item.quantity,
      size: oneSize ? "One size" : item.size,
      color: color.name,
      colorHex: color.hex,
      unitPrice,
      lineTotal: unitPrice * item.quantity
    };
  });

  const total = validatedItems.reduce((sum, item) => sum + item.lineTotal, 0);
  if (!Number.isSafeInteger(total) || total < 1 || total > 5_000_000) {
    throw new OrderValidationError("Order subtotal is outside the allowed range.");
  }

  return { items: validatedItems, total };
}

export function normalizeAccountState(value) {
  if (!isRecord(value) || !Array.isArray(value.cart) || value.cart.length > 20
    || !Array.isArray(value.wishlist) || value.wishlist.length > products.length) {
    throw new OrderValidationError("Account shopping data is invalid.");
  }

  const wishlist = [...new Set(value.wishlist)];
  if (wishlist.length !== value.wishlist.length || wishlist.some(id => !productById.has(id))) {
    throw new OrderValidationError("Saved products are invalid.");
  }

  const cart = value.cart.map(item => {
    if (!isRecord(item) || !validateQuantity(item.quantity)) {
      throw new OrderValidationError("Cart items are invalid.");
    }

    if (item.productId === "custom-low") {
      if (!isRecord(item.colors)) throw new OrderValidationError("Custom shoe colors are invalid.");
      const colors = {};
      for (const part of Object.keys(customColors)) {
        if (!customColors[part].includes(item.colors[part])) {
          throw new OrderValidationError("Custom shoe colors are invalid.");
        }
        colors[part] = item.colors[part];
      }
      return { productId: "custom-low", quantity: item.quantity, colors };
    }

    const product = productById.get(item.productId);
    if (!product) throw new OrderValidationError("Cart items are invalid.");
    const oneSize = product.sizes.length === 1 && product.sizes[0] === "One size";
    const size = oneSize ? "One size" : item.size;
    if (!product.sizes.includes(size)) throw new OrderValidationError("Cart item size is invalid.");
    const color = product.colors.find(variant => variant.name === item.color);
    if (!color) throw new OrderValidationError("Cart item color is invalid.");
    return { productId: product.id, quantity: item.quantity, size, color: color.name };
  });

  return { cart, wishlist };
}
