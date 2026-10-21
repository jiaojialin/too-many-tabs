// Copies the sql.js browser build into extension/vendor so the unpacked
// extension can load it without a bundler. Run after upgrading sql.js.
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dest = `${root}extension/vendor`;
mkdirSync(dest, { recursive: true });
for (const file of ['sql-wasm.js', 'sql-wasm.wasm']) {
  copyFileSync(`${root}node_modules/sql.js/dist/${file}`, `${dest}/${file}`);
  console.log(`copied ${file}`);
}
