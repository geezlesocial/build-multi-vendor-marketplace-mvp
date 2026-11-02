import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import sharp from "sharp";

const sourceDirectory = process.argv[2];
if (!sourceDirectory) {
  throw new Error(
    "Pass the directory containing the six owner-supplied source JPEGs.",
  );
}

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const destinationDirectory = path.join(
  repositoryRoot,
  "apps/web/public/theme-previews",
);
const source = path.resolve(sourceDirectory);
const assets = [
  ["1. Classic free.jpg", "classic.webp"],
  ["2. Editorial free.jpg", "editorial.webp"],
  ["3. Boutique free.jpg", "boutique.webp"],
  ["4. Tech & Electronics.jpg", "tech-electronics.webp"],
  ["5. Groceries.jpg", "groceries.webp"],
  ["6. Ecommerce Marketplace.jpg", "ecommerce-marketplace.webp"],
];

await mkdir(destinationDirectory, { recursive: true });

for (const [sourceName, destinationName] of assets) {
  const destination = path.join(destinationDirectory, destinationName);
  const result = await sharp(path.join(source, sourceName), {
    limitInputPixels: 40_000_000,
    failOn: "error",
  })
    .rotate()
    .resize({
      width: 1400,
      height: 1400,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 82, effort: 5 })
    .toFile(destination);
  const verified = await sharp(destination).metadata();
  if (
    verified.format !== "webp" ||
    !verified.width ||
    !verified.height ||
    verified.exif ||
    verified.xmp ||
    verified.iptc
  ) {
    throw new Error(`${destinationName} failed output or metadata validation.`);
  }
  console.log(
    `${destinationName}: ${result.width}x${result.height}, ${result.size} bytes`,
  );
}
