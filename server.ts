import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { loadEnvironment } from './server/env';
import { createApp } from './server/app';
import { bootstrapWebsite } from './server/bootstrap';

loadEnvironment();
const production = process.env.NODE_ENV === 'production' || process.argv.includes('--production');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const { app, db } = createApp({
  dataDir: path.resolve(process.env.INNOVISTA_DATA_DIR || 'data'),
  legacyPath: process.env.INNOVISTA_TEST === 'true' ? undefined : path.resolve('sintertechnik.db'),
  production,
  origin: process.env.INNOVISTA_ORIGIN,
});
if (process.env.INNOVISTA_TEST !== 'true') await bootstrapWebsite(db);
if (!production) {
  const { createServer } = await import('vite');
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use((req, res, next) => {
    if (
      req.path === '/' ||
      req.path === '/index.html' ||
      // shared/ holds the types and constants the browser and server both use.
      /^\/(src\/|shared\/|node_modules\/|@vite\/|@react-refresh|@id\/|branding\/)/.test(req.path)
    )
      return next();
    res.status(404).send('Not found');
  });
  app.use(vite.middlewares);
} else {
  const dist = path.resolve('dist');
  if (!fs.existsSync(path.join(dist, 'index.html')))
    throw new Error('Run npm run build before starting production.');
  app.use(express.static(dist, { dotfiles: 'deny', index: 'index.html' }));
  app.get('/', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}
const server = app.listen(port, host, () =>
  console.log('Innovista Research AI is ready at http://' + host + ':' + port),
);
server.requestTimeout = 120000;
function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
