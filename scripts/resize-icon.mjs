import sharp from 'sharp';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'assets', 'icon.png');
const OUT_DIR = path.join(ROOT, 'public', 'icon');
const SIZES = [16, 32, 48, 128];

for (const size of SIZES) {
  const out = path.join(OUT_DIR, `${size}.png`);
  if (path.resolve(out) === path.resolve(SRC)) {
    throw new Error(`Refusing to overwrite source ${SRC} with output for size ${size}`);
  }
  await sharp(SRC).resize(size, size, { fit: 'contain' }).png().toFile(out);
  console.log(`wrote ${out}`);
}
