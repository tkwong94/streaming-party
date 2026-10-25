#!/usr/bin/env node
// Fake `cloudflared` for tests and the host-guide rehearsal. Prints a Quick Tunnel banner on stderr
// (like the real tool), then stays alive until SIGTERM/SIGINT. It never reads tokens or writes files.
//   FAKE_TUNNEL_MODE=silent      print nothing (simulates a tunnel that never reports a URL)
//   FAKE_TUNNEL_SUBDOMAIN=<sub>  host printed as https://<sub>.trycloudflare.com (default abc-def)
const args = process.argv.slice(2);
if (args[0] !== 'tunnel' || args[1] !== '--url') {
  process.stderr.write('fake-cloudflared: unexpected arguments\n');
  process.exit(64);
}

const subdomain = process.env.FAKE_TUNNEL_SUBDOMAIN ?? 'abc-def';
const url = `https://${subdomain}.trycloudflare.com`;
const log = (line) => process.stderr.write(`${new Date().toISOString()} INF ${line}\n`);

if (process.env.FAKE_TUNNEL_MODE !== 'silent') {
  log('Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment.');
  log('Requesting new quick Tunnel on trycloudflare.com...');
  log('+--------------------------------------------------------------------------------------------+');
  log('|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |');
  log(`|  ${url.padEnd(90)}|`);
  log('+--------------------------------------------------------------------------------------------+');
  log(`Version 2026.10.0 (fake) forwarding to ${args[2] ?? ''}`);
}

const keepAlive = setInterval(() => {}, 1 << 30);
const stop = () => {
  clearInterval(keepAlive);
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
