import { listPublicTree } from '../services/drivePublic.js';
const t = await listPublicTree('10uXHXXsNNq4KdOsv0bPnIBE2LZMBEwr2');
const c: Record<string, number> = {};
for (const e of t) c[e.kind] = (c[e.kind] ?? 0) + 1;
console.log(c);
for (const e of t) if (e.kind !== 'image') console.log(e.kind.padEnd(6), e.path + e.name);
