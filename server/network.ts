import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import ipaddr from 'ipaddr.js';
import { HttpError } from './validation';

export function isPublicIp(address: string): boolean {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}
export function checkedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'Enter a valid public website URL.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !['80', '443'].includes(url.port)) ||
    host === 'localhost' ||
    /\.(localhost|local|internal|test|invalid)$/i.test(host) ||
    (net.isIP(host) && !isPublicIp(host))
  ) {
    throw new HttpError(400, 'Only public HTTP(S) websites on standard ports are supported.');
  }
  return url;
}
export interface NetworkResponse {
  text: string;
  url: string;
  status: number;
  contentType: string;
}
export async function publicRequest(
  raw: string,
  options: {
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    timeout?: number;
    maxBytes?: number;
  } = {},
  redirects = 0,
): Promise<NetworkResponse> {
  const url = checkedUrl(raw);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const records = await Promise.race([
    dns.lookup(hostname, { all: true }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HttpError(504, 'Website DNS lookup timed out.')), 5000);
    }),
  ]).finally(() => clearTimeout(timer));
  if (!records.length || records.some((r) => !isPublicIp(r.address)))
    throw new HttpError(400, 'The website resolves to a private or reserved network.');
  const address = records[0];
  const response = await new Promise<{
    status: number;
    type: string;
    location?: string;
    text: string;
  }>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(
      url,
      {
        method: options.method || 'GET',
        agent: false,
        headers: {
          'User-Agent': 'InnovistaResearchAI/2.0',
          'Accept-Encoding': 'identity',
          ...options.headers,
        },
        // Pin the already-validated address for this connection. TLS still verifies the original hostname.
        lookup: ((_host: string, opts: { all?: boolean }, cb: Function) =>
          opts.all ? cb(null, [address]) : cb(null, address.address, address.family)) as never,
        signal: AbortSignal.timeout(options.timeout || 12000),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > (options.maxBytes || 1_000_000)) {
            res.destroy();
            request.destroy(new HttpError(413, 'The remote response is too large.'));
          } else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () =>
          resolve({
            status: res.statusCode || 502,
            type: String(res.headers['content-type'] || ''),
            location: res.headers.location,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.on('error', reject);
    request.end(options.body);
  });
  if (response.status >= 300 && response.status < 400) {
    if (options.method === 'POST' || !response.location || redirects >= 3)
      throw new HttpError(502, 'Remote redirect refused. Use the final public URL.');
    return publicRequest(new URL(response.location, url).href, options, redirects + 1);
  }
  return {
    text: response.text,
    url: url.href,
    status: response.status,
    contentType: response.type,
  };
}
export function researchLinks(html: string, base: string): string[] {
  const links = new Set<string>();
  const origin = new URL(base);
  for (const match of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const url = new URL(match[1].replace(/&amp;/g, '&'), origin);
      url.hash = '';
      if (
        url.origin === origin.origin &&
        /about|company|product|application|engineering|unternehmen|ueber|produkte|anwendung/i.test(
          url.pathname,
        ) &&
        url.href !== origin.href
      )
        links.add(url.href);
    } catch {
      /* Ignore malformed links in untrusted HTML. */
    }
  }
  return [...links].slice(0, 2);
}
export interface WebsitePage {
  url: string;
  content: string;
  truncated: boolean;
  links?: string[];
}
export async function fetchWebsite(raw: string): Promise<WebsitePage> {
  const response = await publicRequest(raw);
  if (response.status < 200 || response.status >= 300)
    throw new HttpError(
      422,
      'The website could not be read (HTTP ' +
        response.status +
        '). Attach a document or paste source text instead.',
    );
  if (!/text\/(html|plain)|application\/xhtml\+xml/i.test(response.contentType))
    throw new HttpError(
      422,
      'This URL does not serve a readable web page. Upload documents through the source library.',
    );
  const text = response.text
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < 80)
    throw new HttpError(
      422,
      'The page has too little readable text. Paste its content or upload a document.',
    );
  return {
    url: response.url,
    content: text.slice(0, 30000),
    truncated: text.length > 30000,
    links: researchLinks(response.text, response.url),
  };
}
