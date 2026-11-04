import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const products = JSON.parse(await readFile(path.join(root, "catalog.json"), "utf8"));
const outputDirectory = path.join(root, "images", "products");

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function illustration(product, color, detail) {
  if (product.category === "Footwear" || product.subcategory.includes("shoes") || product.subcategory.includes("boots")) {
    return `<path d="M75 178c28-7 54-22 79-49l35-39q14-15 28 1l41 55q18 23 48 30l49 10q22 5 25 26l-3 24H85q-28 0-31-22-2-22 21-36Z" fill="${color}" stroke="#252a27" stroke-width="8" stroke-linejoin="round"/><path d="M60 221q75 13 142-2 60-13 107 1 43 12 86 7l-4 22H79q-24 0-28-13z" fill="${detail}" stroke="#252a27" stroke-width="7"/><path d="m177 112 56 52m-75-29 53 49m-70-27 46 45" stroke="#fff" stroke-width="9" stroke-linecap="round"/>`;
  }
  if (product.subcategory.includes("shorts")) {
    return `<path d="M116 66h208l-17 108-18 134h-81l-17-91-19 91h-81l-17-134z" fill="${color}" stroke="#252a27" stroke-width="8" stroke-linejoin="round"/><path d="M116 66h208l-5 41H121z" fill="${detail}" stroke="#252a27" stroke-width="6"/><path d="M220 107v92" stroke="#fff" stroke-width="8"/>`;
  }
  if (product.subcategory.includes("leggings")) {
    return `<path d="M150 58h140l-8 92-10 153h-62l-8-128-12 128h-62l-10-153z" fill="${color}" stroke="#252a27" stroke-width="8" stroke-linejoin="round"/><path d="M150 58h140v37H150z" fill="${detail}" stroke="#252a27" stroke-width="6"/>`;
  }
  if (product.category === "Clothing" || product.category === "Campus Collection" || product.category === "Kids") {
    const hood = product.subcategory.toLowerCase().includes("hoodie");
    const sleeves = product.subcategory.toLowerCase().includes("jacket") || product.subcategory.toLowerCase().includes("top");
    const topPath = hood
      ? "M166 78q10-47 54-47t54 47l43 15 37 43-31 27-27-33v142H144V130l-27 33-31-27 37-43z"
      : `M124 78 170 58h20q10 25 30 25t30-25h20l46 20 34 ${sleeves ? "77" : "32"}-32 19-25-18v${sleeves ? "141" : "119"}H147V${sleeves ? "156" : "128"}l-25 18-32-19z`;
    return `<path d="${topPath}" fill="${color}" stroke="#252a27" stroke-width="8" stroke-linejoin="round"/><path d="M149 151h142v20H149z" fill="${detail}" opacity=".95"/><path d="M169 66q10 36 51 36t51-36" fill="none" stroke="#fff" stroke-width="8"/>`;
  }
  if (product.subcategory.includes("bags") || product.subcategory.includes("Backpacks")) {
    return `<path d="M105 118q0-24 25-24h180q25 0 25 24l16 158q3 24-23 24H101q-26 0-23-24z" fill="${color}" stroke="#252a27" stroke-width="8"/><path d="M157 98q7-57 63-57t63 57" fill="none" stroke="${detail}" stroke-width="14"/><path d="M92 218h256" stroke="#fff" stroke-width="9"/><rect x="154" y="215" width="132" height="55" rx="8" fill="${detail}" stroke="#252a27" stroke-width="6"/>`;
  }
  if (product.subcategory.includes("bottle")) {
    return `<rect x="158" y="91" width="124" height="225" rx="32" fill="${color}" stroke="#252a27" stroke-width="8"/><path d="M188 49h64v43h-64z" fill="${detail}" stroke="#252a27" stroke-width="7"/><path d="M168 173h104v49H168z" fill="#fff" opacity=".8"/><path d="M220 183v29m-12-15h24" stroke="${color}" stroke-width="8" stroke-linecap="round"/>`;
  }
  if (product.subcategory.includes("caps")) {
    return `<path d="M77 221q6-119 133-139 99-15 147 91-78-24-139 8-42 22-57 68l-77-28z" fill="${color}" stroke="#252a27" stroke-width="8" stroke-linejoin="round"/><path d="M166 244q80-94 209-73 26 5 24 24-2 16-25 21l-198 34z" fill="${detail}" stroke="#252a27" stroke-width="8"/>`;
  }
  if (product.subcategory.includes("socks")) {
    return `<path d="M150 51h80v140q0 26 28 38l54 23q22 10 11 33-7 17-29 17h-88q-34 0-34-34V151h-22z" fill="${color}" stroke="#252a27" stroke-width="8" stroke-linejoin="round"/><path d="M150 54h80v42h-80zm0 49h80" fill="${detail}" stroke="#252a27" stroke-width="7"/>`;
  }
  return `<circle cx="220" cy="180" r="95" fill="${color}" stroke="#252a27" stroke-width="8"/><path d="M160 180h120" stroke="${detail}" stroke-width="18" stroke-linecap="round"/><path d="M183 154v52m74-52v52" stroke="#fff" stroke-width="10" stroke-linecap="round"/>`;
}

await mkdir(outputDirectory, { recursive: true });

let count = 0;
for (const product of products) {
  for (const [index, color] of product.colors.entries()) {
    const detail = product.colors[(index + 1) % product.colors.length].hex;
    const filename = `${product.id}_${slug(color.name)}.svg`;
    const imagePath = `./images/products/${filename}`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 440 360" role="img" aria-label="${color.name} ${product.name}"><rect width="440" height="360" rx="28" fill="#eef0ed"/><circle cx="220" cy="180" r="145" fill="#fff" opacity=".7"/>${illustration(product, color.hex, detail)}</svg>\n`;
    await writeFile(path.join(outputDirectory, filename), svg);
    color.image = imagePath;
    count += 1;
  }
}

await writeFile(path.join(root, "catalog.json"), `${JSON.stringify(products, null, 2)}\n`);
console.log(`Generated ${count} color-specific SVG placeholders for ${products.length} products.`);
