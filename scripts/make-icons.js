// Generates PWA icons: green tile + white "J" from a 5x7 pixel font.
// Usage: node scripts/make-icons.js (writes into apps/web/public/)
const path = require('path');
const { PNG } = require('pngjs');

const OUT = path.join(__dirname, '..', 'apps', 'web', 'public');
const BG = [14, 107, 79, 255];   // --je-primary
const FG = [255, 255, 255, 255];

// 5x7 "J"
const J = [
  '00100',
  '00100',
  '00100',
  '00100',
  '10100',
  '10100',
  '01100',
];

function draw(size, pad = 0) {
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      png.data[i] = BG[0]; png.data[i + 1] = BG[1]; png.data[i + 2] = BG[2]; png.data[i + 3] = 255;
    }
  }
  const inner = size - pad * 2;
  const cell = Math.floor(inner / 7);
  const ox = pad + Math.floor((inner - cell * 5) / 2);
  const oy = pad + Math.floor((inner - cell * 7) / 2);
  J.forEach((row, ry) => {
    [...row].forEach((bit, rx) => {
      if (bit !== '1') return;
      for (let dy = 0; dy < cell; dy++) {
        for (let dx = 0; dx < cell; dx++) {
          const x = ox + rx * cell + dx, y = oy + ry * cell + dy;
          const i = (y * size + x) * 4;
          png.data[i] = FG[0]; png.data[i + 1] = FG[1]; png.data[i + 2] = FG[2]; png.data[i + 3] = 255;
        }
      }
    });
  });
  return png;
}

const fs = require('fs');
const jobs = [
  ['icon-192.png', draw(192)],
  ['icon-512.png', draw(512)],
  ['icon-maskable.png', draw(512, 90)], // safe-zone padding for maskable
  ['apple-touch-icon.png', draw(180)],
];
for (const [name, png] of jobs) {
  fs.writeFileSync(path.join(OUT, name), PNG.sync.write(png));
  console.log('wrote', name);
}
