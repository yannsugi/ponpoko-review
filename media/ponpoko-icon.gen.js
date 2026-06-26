const fs = require('fs');
// 手描きの頭グリッド（'#'=塗り '.'=透明）。各行は同じ幅。
const head = [
  '..........#...#.......',
  '.........###.###......',
  '........#########.....',
  '.......###########....',
  '.......##..###..##....',
  '.......##..###..##....',
  '.......###########....',
  '......#############...',
  '......###..###..###...',
  '......###..###..###...',
  '......#############...',
  '.......###########....',
  '.......#####.#####....',
  '.......###########....',
  '........#########.....',
  '.........#######......',
];
const W = head[0].length;
head.forEach((r, i) => { if (r.length !== W) throw new Error(`row ${i} width ${r.length}!=${W}`); });
const Hpad = 4;               // 尻尾の下余白
const H = head.length + Hpad;
const g = Array.from({length: W}, () => new Array(H).fill(false));
head.forEach((row, y) => [...row].forEach((c, x) => { if (c === '#') g[x][y] = true; }));

// 手続き的に縞尻尾を左下に
const inb = (x, y) => x >= 0 && x < W && y >= 0 && y < H;
const set = (x, y, v) => { if (inb(Math.round(x), Math.round(y))) g[Math.round(x)][Math.round(y)] = v; };
function disc(cx, cy, r, v = true) {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++)
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) set(x, y, v);
}
const tail = [[5,11],[4,13],[3.2,15],[3,17],[3.6,19]];
for (const [x, y] of tail) disc(x, y, 2.3);
// ring gaps（縞）
for (const yy of [12.5, 15.5, 18.5]) for (let x = 0; x < 7; x++) set(x, yy, false);

const rects = [];
for (let y = 0; y < H; y++) {
  let x = 0;
  while (x < W) {
    if (g[x][y]) { let run = 1; while (x + run < W && g[x + run][y]) run++; rects.push(`<rect x="${x}" y="${y}" width="${run}" height="1"/>`); x += run; }
    else x++;
  }
}
const svg =
`<svg width="${W*2}" height="${H*2}" viewBox="0 0 ${W} ${H}" fill="currentColor" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">
${rects.map(r => '  ' + r).join('\n')}
</svg>
`;
fs.writeFileSync(process.argv[2] || '/tmp/icon_out.svg', svg);
console.log(`${W}x${H}, ${rects.length} rects`);
