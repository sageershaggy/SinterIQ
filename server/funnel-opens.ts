import crypto from 'node:crypto';
import type { Express, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { hash, now, type DB } from './database';

/**
 * "Count opens" for funnel messages, and nothing else: individual mail never carries the image.
 *
 * A funnel message's HTML part ends with a 1×1 transparent GIF whose address holds a random
 * token made for that one message (256 bits, only its hash stored). When a mail app loads the
 * image, GET /e/o/<token>.gif records the first time and counts the fetch. Like the unsubscribe
 * page, the route sits outside /api: no session and no CSRF header, because the recipient's mail
 * app is the caller and the token is the only authority. Unlike it, the route never changes a
 * preference: an image load is something mail apps do on their own, so it may only ever count.
 *
 * The answer never says whether a token matched: every request, a rate-limited one included,
 * gets the same image with the same headers. Nothing about the reader is kept — no address, no
 * user agent. The rate limiter keys on the address in memory for one minute and writes nothing.
 */

/** The smallest transparent GIF. */
const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const pixelFile = /^([a-f0-9]{64})\.gif$/;

/**
 * Makes the token for one funnel message, before it is sent: an open can then never arrive for
 * a token the database does not hold yet. Returns the image address to put in its HTML.
 */
export function issueOpenToken(
  db: DB,
  publicOrigin: string,
  message: { projectId: number; leadId: number; enrollmentId: number; step: number },
) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hash(token);
  db.prepare(
    `INSERT INTO funnel_message_opens (token_hash,project_id,lead_id,enrollment_id,step,created_at)
    VALUES (?,?,?,?,?,?)`,
  ).run(tokenHash, message.projectId, message.leadId, message.enrollmentId, message.step, now());
  return { tokenHash, url: publicOrigin + '/e/o/' + token + '.gif' };
}

/**
 * A message that certainly did not leave takes its token with it. One whose acceptance is
 * uncertain keeps it: an open would show that it arrived after all.
 */
export function discardOpenToken(db: DB, tokenHash: string, deliveryKey: string) {
  db.prepare(
    `DELETE FROM funnel_message_opens WHERE token_hash=? AND NOT EXISTS (SELECT 1 FROM email_deliveries
      WHERE delivery_key=? AND status IN ('SENDING','SENT','UNKNOWN'))`,
  ).run(tokenHash, deliveryKey);
}

/**
 * Puts the image at the end of the HTML body. A message without an HTML part gets none, and the
 * plain-text part never does. The address is the app's own origin and a hex token, so it needs
 * no escaping.
 */
export function withOpenPixel(html: string, url: string) {
  if (!html) return html;
  const image =
    '<img src="' +
    url +
    '" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;margin:0;padding:0">';
  const end = html.lastIndexOf('</body>');
  return end === -1 ? html + image : html.slice(0, end) + image + html.slice(end);
}

export function installOpenTracking(app: Express, db: DB) {
  const answer = (res: Response) => {
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Content-Length', String(pixel.length));
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Helmet allows same-origin embedding only; a webmail page showing the message is another
    // origin, and the image is all this route ever returns.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.status(200).end(pixel);
  };
  const record = db.prepare(
    'UPDATE funnel_message_opens SET open_count=open_count+1,first_opened_at=COALESCE(first_opened_at,?) WHERE token_hash=?',
  );
  const limit = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: false,
    legacyHeaders: false,
    // Over the limit, the same image and nothing recorded.
    handler: (_req, res) => answer(res),
  });
  app.get('/e/o/:file', limit, (req, res) => {
    const match = pixelFile.exec(String(req.params.file));
    // Express answers HEAD with this route too; a link checker's HEAD is not an open.
    if (match && req.method === 'GET') record.run(now(), hash(match[1]));
    answer(res);
  });
}
