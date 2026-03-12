const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);

function isPathInsideRoot(rootPath, candidatePath) {
  const root = path.resolve(rootPath) + path.sep;
  const candidate = path.resolve(candidatePath);
  return candidate.startsWith(root);
}

/**
 * Browser ESM requires fully specified URLs (including .js).
 * Some packages (like golden-layout dist/esm) emit extensionless imports.
 * This middleware maps extensionless requests to the corresponding .js file.
 */
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();

  let urlPath;
  try {
    urlPath = decodeURIComponent(req.path);
  } catch {
    return next();
  }

  if (!urlPath || path.extname(urlPath)) return next();

  // req.path is absolute (starts with "/"). Prefix with "." so path.join stays under ROOT.
  const requestedFsPath = path.join(ROOT, `.${urlPath}`);
  const candidateJsPath = requestedFsPath + '.js';
  if (!isPathInsideRoot(ROOT, candidateJsPath)) return next();

  if (fs.existsSync(candidateJsPath) && fs.statSync(candidateJsPath).isFile()) {
    res.type('application/javascript');
    return res.sendFile(candidateJsPath);
  }

  return next();
});

app.use(express.static(ROOT, { extensions: ['html'] }));

app.listen(PORT, () => {
  console.log(`[dev-server] http://127.0.0.1:${PORT}`);
});
