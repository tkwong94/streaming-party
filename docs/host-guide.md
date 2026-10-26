# Hosting a watch party (test01-host)

The party host runs a small sync server on their own computer. `test01-host` starts that server and,
by default, a free Cloudflare Quick Tunnel so guests on other networks can reach it. It checks the
tunnel works, then prints the **Server address** you paste into the extension popup.

No account is needed for Cloudflare Quick Tunnel. The address changes every time you start it, so
create a new party (and send a new invite link) after each start.

## 1. Install the prerequisites

You need Node.js 20 or newer, git, and a tunnel tool.

### Windows

1. Install Node.js LTS from https://nodejs.org/ (tick "Add to PATH"), and Git from https://git-scm.com/download/win.
2. Install cloudflared: `winget install --id Cloudflare.cloudflared`
   (or download it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
3. Open a **new** PowerShell window and check: `node --version` and `cloudflared --version`.

### macOS

1. Install Node.js LTS from https://nodejs.org/ (or `brew install node`).
2. Install cloudflared: `brew install cloudflared`.
3. Check in Terminal: `node --version` and `cloudflared --version`.

### Linux

1. Install Node.js 20+ from your distribution or https://nodejs.org/.
2. Install cloudflared: download the `.deb`, `.rpm` or binary from
   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
   (for example `sudo dpkg -i cloudflared-linux-amd64.deb`).
3. Check: `node --version` and `cloudflared --version`.

ngrok is an alternative (https://ngrok.com/download). It needs a free ngrok account; configure it once
with ngrok's own command (`ngrok config add-authtoken ...`). `test01-host` never reads, prints or
passes your ngrok or cloudflared tokens; the tools use their own configuration.

## 2. Build once

In the project folder (the same commands on all three systems):

```
npm install
npm run build -w shared/protocol
npm run build -w server
```

## 3. Start the server and tunnel

```
npx -w server test01-host
```

(`node server/dist/bin.js` is equivalent.) Expected output:

```
Sync server listening on 127.0.0.1:8787
Starting cloudflared tunnel...
Tunnel ready at https://<random-words>.trycloudflare.com; checking https://<random-words>.trycloudflare.com/healthz ...
Server address: wss://<random-words>.trycloudflare.com/ws
Paste this address into the extension popup before creating the party.
Press Ctrl+C to stop
```

The health check retries for up to 20 seconds while the new tunnel becomes reachable.

## 4. Create the party

1. Open the Netflix or YouTube watch page in Chrome with the extension installed.
2. Click the extension icon. In **Server address**, paste the `wss://...` address from step 3.
3. Enter a nickname and click **Create party**.
4. Copy the **Invite link** and send it to your guests (up to 9 guests; 10 people in total).

Keep the terminal window open for the whole party. Press **Ctrl+C** to stop: the tunnel stops first,
then the server, and the party ends for everyone.

## Options

```
npx -w server test01-host [--tunnel cloudflared|ngrok|none] [--port <1024-65535>] [--lan]
```

- `--tunnel ngrok` uses ngrok instead of Cloudflare. The address looks like `wss://<id>.ngrok-free.app/ws`.
- `--tunnel none --lan` skips the tunnel and listens on your local network. It prints
  `Server address: ws://<your-LAN-IP>:8787/ws`. Use it only when everyone is on the same Wi-Fi/LAN;
  your firewall may ask you to allow Node.js.
- `--tunnel none` without `--lan` is reachable only from this computer (useful for testing).
- `--port` changes the port (default 8787).

## When something goes wrong

| Exit code | Message starts with | What to do |
|---|---|---|
| 2 | `cloudflared executable not found` | Install the tool (step 1) and open a new terminal, or use `--tunnel none`. |
| 3 | `cloudflared reported no public URL within 30 s` | Check your internet connection; run `cloudflared tunnel --url http://127.0.0.1:8787` alone to see its error. |
| 4 | `Health check through the tunnel failed` | The tunnel started but did not reach the server. Wait a minute and start again. |
| 5 | `Port 8787 is already in use` | Another `test01-host` may still be running; close it or use `--port 8788`. |
| 64 | `Usage: test01-host` | Check the options spelled above. |

## Rehearsal without a real tunnel (testers and QA)

The repository includes fake tunnel programs so the helper can be tried without installing anything
or using the internet. The `TEST01_TUNNEL_BIN` variable selects the program to run instead of
`cloudflared`/`ngrok`. Run these after step 2 on Linux/macOS (in PowerShell set the variable with
`$env:TEST01_TUNNEL_BIN="..."` first).

A. Server only, stopped after 2 seconds with Ctrl+C (SIGINT):

```
timeout --preserve-status -s INT 2 node server/dist/bin.js --tunnel none --port 18789; echo EXIT=$?
```

Expected:

```
Sync server listening on 127.0.0.1:18789
No tunnel and no --lan: only this computer can connect.
Server address: ws://127.0.0.1:18789/ws
Paste this address into the extension popup before creating the party.
Press Ctrl+C to stop
Stopping tunnel and server...
EXIT=0
```

B. Fake cloudflared. The fake prints a Quick Tunnel banner for `https://abc-def.trycloudflare.com`,
which does not really exist, so the health check fails after about 20 seconds with exit 4. This shows
the URL detection and the health check guard. The successful path through a tunnel is covered by
automated tests (`npm test -w server -- tunnel host-cli`) and by the human cross-network test.

```
TEST01_TUNNEL_BIN=$PWD/server/test/fixtures/fake-cloudflared.mjs node server/dist/bin.js --port 18788; echo EXIT=$?
```

Expected:

```
Sync server listening on 127.0.0.1:18788
Starting cloudflared tunnel...
Tunnel ready at https://abc-def.trycloudflare.com; checking https://abc-def.trycloudflare.com/healthz ...
Health check through the tunnel failed (fetch failed). Guests could not connect; try again in a minute.
EXIT=4
```

C. Missing tunnel tool:

```
TEST01_TUNNEL_BIN=/nonexistent node server/dist/bin.js --port 18787; echo EXIT=$?
```

Expected: the `cloudflared executable not found. Install cloudflared from https://developers.cloudflare.com/...`
message and `EXIT=2`.
