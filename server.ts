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
const { app, db, funnels, mailbox } = createApp({
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
// Funnels remain drafts until explicitly activated in the app. Persisted due times
// and delivery keys make this bounded worker safe across normal restarts.
let pendingDelivery = Promise.resolve();
// syncAll polls every enabled mailbox in turn, so a slow provider can outlast the interval.
// Skipping a cycle keeps the chain from growing faster than it drains.
let delivering = false;
const funnelTimer = setInterval(() => {
  if (delivering) return;
  delivering = true;
  pendingDelivery = pendingDelivery
    // Every project with an enabled mailbox is polled. syncAll reports a failing provider
    // instead of throwing, so one project's mailbox cannot pause delivery for the rest.
    .then(() => mailbox.syncAll())
    .then((result) => {
      if (result.failures.length) console.error('[mail] ' + result.failures.join(' · '));
    })
    .then(() => funnels.tick())
    .catch((error) =>
      console.error(
        '[mail] Processing paused. Check incoming settings and the outbox.',
        error?.code || error?.name || 'UnknownError',
      ),
    )
    .finally(() => {
      delivering = false;
    });
}, 60_000);
funnelTimer.unref();
function shutdown() {
  clearInterval(funnelTimer);
  server.close(async () => {
    await pendingDelivery;
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
