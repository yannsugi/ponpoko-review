const fs = require('fs');
// 手描きの頭グリッド（'#'=塗り '.'=透明）
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
const Hpad = 4;
const H = head.length + Hpad;
const g = Array.from({length: W}, () => new Array(H).fill(false));
head.forEach((row, y) => [...row].forEach((c, x) => { if (c === '#') g[x][y] = true; }));

const inb = (x, y) => x >= 0 && x < W && y >= 0 && y < H;
const set = (x, y, v) => { if (inb(Math.round(x), Math.round(y))) g[Math.round(x)][Math.round(y)] = v; };
function disc(cx, cy, r, v = true) {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++)
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) set(x, y, v);
}
const tail = [[5,11],[4,13],[3.2,15],[3,17],[3.6,19]];
for (const [x, y] of tail) disc(x, y, 2.3);
for (const yy of [12.5, 15.5, 18.5]) for (let x = 0; x < 7; x++) set(x, yy, false);

// --- 輪郭抽出: 塗りセルのうち4近傍に空(or外)があるものだけ残す ---
const empty = (x, y) => !inb(x, y) || !g[x][y];
const out = Array.from({length: W}, () => new Array(H).fill(false));
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
  if (g[x][y] && (empty(x-1,y) || empty(x+1,y) || empty(x,y-1) || empty(x,y+1))) out[x][y] = true;

// 目と鼻は塗りドットで強調（穴の中心に置く）
const dots = [[8,8],[15,8],[11,12]]; // 左目, 右目, 鼻
for (const [x, y] of dots) out[x][y] = true;

const rects = [];
for (let y = 0; y < H; y++) {
  let x = 0;
  while (x < W) {
    if (out[x][y]) { let run = 1; while (x + run < W && out[x + run][y]) run++; rects.push(`<rect x="${x}" y="${y}" width="${run}" height="1"/>`); x += run; }
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
