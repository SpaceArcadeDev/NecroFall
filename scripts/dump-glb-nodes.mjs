// Dev utility: dump the node hierarchy of a GLB (names, local transforms, nesting).
// Usage: node scripts/dump-glb-nodes.mjs <file.glb>
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/dump-glb-nodes.mjs <file.glb>');
  process.exit(1);
}

const buf = readFileSync(file);
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));

console.log(`=== ${file}`);
console.log(`nodes: ${json.nodes.length}  meshes: ${(json.meshes || []).length}  scenes: ${(json.scenes || []).length}`);

const parentOf = new Map();
(json.nodes || []).forEach((n, i) => (n.children || []).forEach((c) => parentOf.set(c, i)));

(json.nodes || []).forEach((n, i) => {
  if (!n.name) return;
  const t = n.translation || [0, 0, 0];
  const s = n.scale || [1, 1, 1];
  const parent = parentOf.get(i);
  const pname = parent !== undefined ? json.nodes[parent].name || String(parent) : 'ROOT';
  const fmt = (arr) => arr.map((v) => Number(v).toFixed(3)).join(',');
  console.log(`  #${i} '${n.name}' parent=${pname} scale=${fmt(s)} t=${fmt(t)} mesh=${n.mesh ?? '-'}`);
});
