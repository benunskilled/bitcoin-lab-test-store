'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');

// Only workers are gated. The dashboard stays available to show their status.
// A response of ANY status means the old app is running. Ambiguous network
// failures fail closed; only an absent name/refused port means it is stopped.
function legacyRunning(url = process.env.PEERLAB_LEGACY_HEALTH_URL || 'http://bitcoinlab-node_dashboard_1:8788/api/health') {
  return new Promise((resolve, reject) => {
    // A fresh connection every time: a kept-alive socket to an app that has since
    // stopped fails with ECONNRESET, which would read as "cannot tell".
    const request = http.get(url, { agent: false }, (res) => { res.resume(); resolve(true); });
    const timer = setTimeout(() => request.destroy(new Error('Could not check whether Bitcoin Lab is stopped.')), 3000);
    request.on('close', () => clearTimeout(timer));
    request.on('error', (error) => {
      if (['ENOTFOUND', 'ECONNREFUSED'].includes(error.code)) resolve(false);
      else reject(error);
    });
  });
}

async function assertCanRun(readOnly, url) {
  if (!readOnly && await legacyRunning(url)) throw new Error('Stop Bitcoin Lab before starting Peer Lab workers.');
}

async function main() {
  const script = process.argv[2];
  if (!['peer-profiler', 'relay-profiler', 'stratum-race'].includes(script)) throw new Error('Unknown Peer Lab worker.');
  const readOnly = process.env.LAB_READ_ONLY === '1';
  await assertCanRun(readOnly);
  const child = spawn(process.execPath, [`src/${script}.js`], { stdio: 'inherit' });
  let stopped = false;
  let failed = false;
  let checking = false;
  let killTimer;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  };
  const timer = setInterval(async () => {
    if (readOnly || checking || stopped) return;
    checking = true;
    try {
      if (await legacyRunning()) throw new Error('Bitcoin Lab restarted; stopping Peer Lab workers.');
    } catch (error) {
      failed = true;
      console.error(error.message);
      stop();
    } finally { checking = false; }
  }, 15_000);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  child.on('error', (error) => { console.error(error.message); failed = true; });
  child.on('close', (code) => {
    clearInterval(timer);
    clearTimeout(killTimer);
    process.exitCode = failed ? 1 : (stopped ? 0 : (code || 1));
  });
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { legacyRunning, assertCanRun };
