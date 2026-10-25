#!/usr/bin/env node
// Fake `ngrok` for tests and the host-guide rehearsal. Prints JSON log lines on stdout (like
// `ngrok http <port> --log stdout --log-format json`), then stays alive until SIGTERM/SIGINT.
// It never reads tokens or writes files.
//   FAKE_TUNNEL_MODE=silent      print nothing (simulates a tunnel that never reports a URL)
//   FAKE_TUNNEL_SUBDOMAIN=<sub>  host printed as https://<sub>.ngrok-free.app (default 1a2b-203-0-113-7)
const args = process.argv.slice(2);
if (args[0] !== 'http' || !/^\d+$/.test(args[1] ?? '')) {
  process.stderr.write('fake-ngrok: unexpected arguments\n');
  process.exit(64);
}

const subdomain = process.env.FAKE_TUNNEL_SUBDOMAIN ?? '1a2b-203-0-113-7';
const log = (record) => process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), lvl: 'info', ...record })}\n`);

if (process.env.FAKE_TUNNEL_MODE !== 'silent') {
  log({ msg: 'no configuration paths supplied' });
  log({ msg: 'starting web service', obj: 'web', addr: '127.0.0.1:4040' });
  log({ msg: 'tunnel session started', obj: 'tunnels.session' });
  log({
    msg: 'started tunnel',
    obj: 'tunnels',
    name: 'command_line',
    addr: `http://localhost:${args[1]}`,
    url: `https://${subdomain}.ngrok-free.app`,
  });
}

const keepAlive = setInterval(() => {}, 1 << 30);
const stop = () => {
  clearInterval(keepAlive);
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
