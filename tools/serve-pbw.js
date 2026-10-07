#!/usr/bin/env node
'use strict';

/**
 * Serve the built .pbw over the LAN so a phone can fetch it directly.
 *
 * On iOS there is no developer connection, so every build has to reach the
 * phone as a file. AirDrop works; this is quicker when iterating. Open the
 * printed URL on the phone, download, and the Pebble app offers to install it.
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 8787);
const DOWNLOAD_NAME = 'catapult.pbw';

function findPbw() {
  const dir = path.join(ROOT, 'build');
  if (!fs.existsSync(dir)) return null;
  const pbws = fs.readdirSync(dir).filter((f) => f.endsWith('.pbw'));
  return pbws.length ? path.join(dir, pbws[0]) : null;
}

function lanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

/** pebble-tool bundles pyqrcode; use it if it happens to be there. */
function qrCode(url) {
  const python = path.join(os.homedir(), '.local/share/uv/tools/pebble-tool/bin/python');
  if (!fs.existsSync(python)) return null;
  try {
    return execFileSync(
      python,
      ['-c', 'import sys,pyqrcode;print(pyqrcode.create(sys.argv[1]).terminal(quiet_zone=1))', url],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
  } catch {
    return null;
  }
}

const pbw = findPbw();
if (!pbw) {
  console.error('No .pbw in build/. Run `npm run build` first.');
  process.exit(1);
}

const host = lanAddress();
if (!host) {
  console.error('No LAN address found. Is WiFi on?');
  process.exit(1);
}

const server = http.createServer((request, response) => {
  // Any path serves the app: a phone browser should not need an exact URL.
  //
  // Found again per request, not held from startup: `npm run build` runs
  // `pebble clean` first, so build/ is empty for a moment, and a rename gives
  // the file a different name. Either leaves a path from startup pointing at
  // nothing.
  const current = findPbw();
  let body = null;
  try {
    if (current) body = fs.readFileSync(current);
  } catch {
    body = null;
  }
  if (body === null) {
    response.writeHead(503, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    response.end('No .pbw in build/ right now. If a build is running, try again in a moment.\n');
    console.log('  no .pbw in build/ right now');
    return;
  }

  response.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-disposition': `attachment; filename="${DOWNLOAD_NAME}"`,
    'content-length': body.length,
    'cache-control': 'no-store'
  });
  response.end(body);
  console.log(`  served ${(body.length / 1024).toFixed(0)} KB to ${request.socket.remoteAddress}`);
});

server.listen(PORT, () => {
  const url = `http://${host}:${PORT}/${DOWNLOAD_NAME}`;
  const qr = qrCode(url);
  if (qr) console.log(qr);
  console.log(`  ${path.relative(ROOT, pbw)}  (${(fs.statSync(pbw).size / 1024).toFixed(0)} KB)`);
  console.log(`\n  Open on your phone:  ${url}\n`);
  console.log('  Same WiFi as this Mac. Download it, then open it with the Pebble app.');
  console.log('  Ctrl-C to stop.\n');
});
