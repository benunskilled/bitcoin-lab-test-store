'use strict';

const http = require('node:http');

// The map is an internal, read-only module. Never forward cookies, credentials,
// browser-controlled hosts, or mutations to it. Dashboard writes retain their
// original source and CSRF checks because there is no proxy in front of them.
function proxyPeers(req, res, url, target = process.env.PEERS_URL || 'http://peers:8789') {
  if (url.pathname !== '/peers' && !url.pathname.startsWith('/peers/')) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return true;
  }
  if (url.pathname === '/peers') {
    res.writeHead(308, { Location: '/peers/' + url.search }).end();
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
    // FileServer may redirect /index.html to ./; absolute redirects stay under /map.
    const location = reply.headers.location;
    if (location && !/^(?:[a-z]+:)?\/\//i.test(location)) {
      outgoing.location = location.startsWith('/') ? '/peers' + location : location;
    }
    res.writeHead(reply.statusCode, outgoing);
    reply.on('error', () => res.destroy());
    reply.pipe(res);
  });
  const deadline = setTimeout(() => request.destroy(new Error('map timeout')), 70_000);
  const clear = () => clearTimeout(deadline);
  res.on('close', () => { clear(); request.destroy(); });
  request.on('error', () => {
    clear();
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('The Peer Lab map service is unavailable. Return to the dashboard or try again shortly.');
  });
  request.end();
  return true;
}

module.exports = { proxyPeers };
