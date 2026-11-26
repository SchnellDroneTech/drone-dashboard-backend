/**
 * Fix yargs@17 on Node >= 25.
 *
 * yargs@17 declares "type": "module" but ships its CommonJS `yargs/yargs`
 * entry as an EXTENSIONLESS file containing require() calls. Node <= 24
 * treated extensionless files as CJS; Node 25+ parses them as ESM because of
 * the package type, so the file's own require() blows up with
 * "require is not defined in ES module scope".
 *
 * puppeteer -> @puppeteer/browsers -> CLI.js does `require("yargs/yargs")`,
 * which makes the whole backend unstartable on Node 25/26.
 *
 * This copies that file to a `.cjs` twin (always CJS, whatever the package
 * type says) and repoints the package's "require" condition at it.
 * Idempotent, and never fails the install.
 */
const fs = require('fs');
const path = require('path');

function main() {
  const dir = path.join(__dirname, '..', 'node_modules', 'yargs');
  const pkgPath = path.join(dir, 'package.json');
  const legacy = path.join(dir, 'yargs');      // extensionless, broken on Node 25+
  const patched = path.join(dir, 'yargs.cjs'); // .cjs is always CommonJS

  if (!fs.existsSync(pkgPath) || !fs.existsSync(legacy)) return; // nothing to do

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (pkg.type !== 'module') return; // already CJS package, unaffected

  fs.copyFileSync(legacy, patched);

  // exports["./yargs"] is an array of condition objects in yargs@17
  const entry = pkg.exports && pkg.exports['./yargs'];
  const repoint = (o) => {
    if (o && typeof o === 'object' && o.require === './yargs') o.require = './yargs.cjs';
  };
  if (Array.isArray(entry)) entry.forEach(repoint);
  else repoint(entry);

  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log('[patch-yargs] yargs/yargs redirected to yargs.cjs (Node 25+ compatibility)');
}

try {
  main();
} catch (err) {
  console.warn('[patch-yargs] skipped:', err.message);
}
