'use strict';

const http = require('node:http');

// The peers service is internal and read-only: the page loads its script,
// its map and its peer list from it under /peers/. Never forward cookies,
// credentials, browser-controlled hosts, or mutations to it. Dashboard writes
// keep their own source and CSRF checks, with no proxy in front of them.
// /peers itself is no page: it leads to the page, at /.
const PAGE_PATHS = new Set(['/peers/app.js', '/peers/world.json', '/peers/api/peers']);

function proxyPeers(req, res, url, target = process.env.PEERS_URL || 'http://peers:8789') {
  if (url.pathname !== '/peers' && !url.pathname.startsWith('/peers/')) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return true;
  }
  if (url.pathname === '/peers' || url.pathname === '/peers/') {
    res.writeHead(308, { Location: '/' }).end();
    return true;
  }
  // Only what the page loads from there, spelled exactly so. The service
  // also answers the dashboard and the profiler (/api/kinds, /api/peerinfo:
  // Core's raw peer list), and Go decodes %70 to p before it matches a
  // path, so a list of what is NOT passed on could be spelled around.
  if (!PAGE_PATHS.has(url.pathname)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('Not found');
    return true;
  }
  const upstream = new URL(target);
  if (upstream.protocol !== 'http:') throw new Error('PEERS_URL must use internal HTTP');
  // Assign the path, do not resolve it as a URL: //evil must never change host.
  upstream.pathname = url.pathname.slice('/peers'.length);
  upstream.search = url.search;
  const headers = {};
  for (const name of ['accept', 'accept-encoding', 'if-none-match', 'if-modified-since', 'range']) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }
  const request = http.request(upstream, { method: req.method, headers }, (reply) => {
    const outgoing = {};
    for (const name of ['content-type', 'content-length', 'content-encoding', 'cache-control',
      'etag', 'last-modified', 'vary', 'content-range', 'accept-ranges',
      'content-security-policy', 'x-content-type-options', 'referrer-policy']) {
      if (reply.headers[name] !== undefined) outgoing[name] = reply.headers[name];
    }
    res.writeHead(reply.statusCode, outgoing);
    reply.on('error', () => res.destroy());
    reply.pipe(res);
  });
  const deadline = setTimeout(() => request.destroy(new Error('peers timeout')), 70_000);
  const clear = () => clearTimeout(deadline);
  res.on('close', () => { clear(); request.destroy(); });
  request.on('error', () => {
    clear();
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('The Peer Lab peers service is unavailable. Reload the page or try again shortly.');
  });
  request.end();
  return true;
}

module.exports = { proxyPeers };
