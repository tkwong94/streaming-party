#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { runHost } from './host-cli.js';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

const code = await runHost(process.argv.slice(2), {
  spawn,
  fetch: (input, init) => fetch(input, init),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  signal: controller.signal,
});
process.exit(code);
