import fs from 'node:fs';
import path from 'node:path';

process.chdir(new URL('..', import.meta.url).pathname);
const files = ['src/main.js','src/world.js','src/weather.js','src/drone.js','src/trainer.js','src/prompt.js','src/swarm.js'];

const exportsMap = {};
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const ex = new Set();
  for (const m of src.matchAll(/export\s+(?:class|function|const|let)\s+([A-Za-z0-9_]+)/g)) ex.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const piece of m[1].split(',')) {
      const nm = piece.trim().split(/\s+as\s+/).pop();
      if (nm) ex.add(nm);
    }
  }
  exportsMap[f] = ex;
}

console.log('Exports per file:');
for (const [f, ex] of Object.entries(exportsMap)) console.log('  ' + f + ' -> ' + [...ex].join(', '));

let errors = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g)) {
    const names = m[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0]);
    const spec = m[2];
    if (spec.startsWith('.')) {
      const target = path.normalize(path.join(path.dirname(f), spec));
      const ex = exportsMap[target];
      if (ex === undefined) {
        console.log('  MISSING file ' + target + ' imported by ' + f);
        errors++;
        continue;
      }
      for (const n of names) {
        if (!ex.has(n)) {
          console.log('  MISSING export ' + n + ' in ' + target + ' (imported by ' + f + ')');
          errors++;
        }
      }
    }
  }
}
console.log(errors === 0 ? '\nOK — all relative imports resolve.' : '\n' + errors + ' import error(s).');
