const fs = require('fs');
const path = require('path');

function listJsFiles(dirPath) {
  /** @type {string[]} */
  const results = [];
  const stack = [dirPath];

  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;

    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

function rewriteRelativeSpecifiers(code) {
  // Fix extensionless relative specifiers (browser ESM requires fully specified URLs).
  // Example: `from './ts/utils/types'` -> `from './ts/utils/types.js'`
  return code.replace(/(\bfrom\s+['"])(\.{1,2}\/[^'"]+)(['"])/g, (match, prefix, specifier, suffix) => {
    if (!specifier.startsWith('.')) return match;
    if (path.extname(specifier)) return match;
    return `${prefix}${specifier}.js${suffix}`;
  });
}

function patchFile(filePath) {
  const original = fs.readFileSync(filePath, 'utf8');
  const updated = rewriteRelativeSpecifiers(original);
  if (updated === original) return false;

  fs.writeFileSync(filePath, updated, 'utf8');
  return true;
}

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const esmRoot = path.join(repoRoot, 'node_modules', 'golden-layout', 'dist', 'esm');

  if (!fs.existsSync(esmRoot)) {
    console.warn(`[patch-golden-layout-esm] Skipped: not found: ${esmRoot}`);
    return;
  }

  const jsFiles = listJsFiles(esmRoot);
  let patchedCount = 0;

  for (const filePath of jsFiles) {
    try {
      if (patchFile(filePath)) patchedCount += 1;
    } catch (err) {
      console.warn(`[patch-golden-layout-esm] Failed: ${filePath}`);
      console.warn(err && err.message ? err.message : String(err));
    }
  }

  console.log(`[patch-golden-layout-esm] Patched ${patchedCount}/${jsFiles.length} files`);
}

main();

