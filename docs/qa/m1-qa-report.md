# M1 independent re-QA report (T17, R1.1 repair round 1)

- Tested revision: `5d741a20a75402cb3b58a636eee7e9faab003f69` (T16b), chain 5d741a2 -> e69b234 (T16c) -> b87bc4e (T16a) -> eb527ba. Branch `test01/T17`. The worktree was clean at the start (`artifacts/T17/base-state.log`).
- Specs: `design/m1-spec.json` (sha256 `39e398c3...2242`, 39 acceptance criteria) and `design/r1-repair-spec.json` (sha256 `97bd4061...cde5`)
- Environment: Linux, Node 26.7.0, npm 12.0.2, Playwright Chromium 1248 (D17 cache), default Chromium settings, no granted permissions
- Evidence: `/workspaces/p-8dcbe667edfc286d6fdd09d6/artifacts/T17/` (one log per attempt; each has an `EXIT=` line)
- Matrix: `docs/qa/m1-qa-matrix.json` (39 spec acceptance rows plus the 2 human-test rows H1 and H2)
- Independence: QA session `20261026_092654_44cd68`. The author sessions were T16a `20261026_075405_0dd5c1`, T16c `20261026_080512_de3dc4` and T16b `20261026_082628_f41ff6`. QA changed no product code; the QA commit touches only the two files in `docs/qa/`.

## Verdict

| Status | Rows |
|---|---|
| passed | 36 |
| failed | 0 |
| untested | 5 (R4.5, R7.4, R8.5, H1, H2: acceptance only a human can confirm) |
| blocked | 0 |

The repair target **R1.1 has moved from failed (T15 at eb527ba) to passed**. On real `https://www.youtube.com/watch?v=aqz-KE-bpKQ`, with default Chromium settings and the server on loopback, popup Create returned an invite in 66 ms and in 61 ms, and the server recorded 1 create each time. The second repair target, R2.3 (tab close), still passes. Every R3/R4/R6 sync figure comes from the fixture page and the simulated-delay proxy. None of it is Netflix or real-internet acceptance.

## Proof commands (all at HEAD 5d741a2)

| Command | Result | Log |
|---|---|---|
| npm install | EXIT=0 (warning: esbuild postinstall blocked; builds unaffected) | proof-npm-install.log |
| npx playwright install chromium | EXIT=0 | proof-playwright-install.log |
| npm run env:check | EXIT=0 | proof-env-check.log |
| npm run env:reset | EXIT=0 (fixture WAV regenerated) | proof-env-reset.log |
| npm run build --workspaces --if-present | EXIT=0 | proof-build-workspaces.log |
| npm run build:test -w extension | EXIT=0; dist-test/manifest.json sha256 38aa6c60...fb39 | proof-build-test.log, proof-build-outputs.log |
| npm run build:adapter-smoke -w extension | EXIT=0; dist-smoke/adapter-smoke.js sha256 b4967502...ac13 | proof-build-adapter-smoke.log |
| WebSocket location check | `content_ws=false background_ws=true`, EXIT=0 | proof-ws-location.log |
| npm test --workspaces --if-present | EXIT=0: protocol 11/11, server 84/84, extension 101/101; e2e 26 passed, 1 skipped (youtube_real_create, see below) | unit-workspaces-attempt1.log |
| npm test -w e2e -- public-origin | EXIT=0, 6/6 | public-origin-attempt1.log |
| npm test -w e2e -- youtube-real-create | EXIT=0, 1 passed (not skipped) | youtube-real-create-attempt1.log |
| npm run test:e2e | EXIT=0, 27/27 (9.5 min) | test-e2e-attempt1.log |

No attempt failed and none was incomplete. Unit counts compared with the T15 baseline: extension went from 72 to 101; protocol (11) and server (84) are unchanged. The e2e count went from 20 to 27 (7 new tests); no earlier test was lost.

## Named tests

| Test | Result | Evidence |
|---|---|---|
| fresh_environment_reproduces | pass | Install, env:check, env:reset and all three builds exit 0. Both build outputs exist. The smoke specs pass 3/3 in both e2e runs. Note: `node_modules` was installed by this session's `npm install`; env:reset cleared the profiles and test results. |
| all_unit_suites_pass | pass | 11/11, 84/84, 101/101 (unit-workspaces-attempt1.log EXIT=0). |
| all_e2e_suites_pass | pass | `npm run test:e2e` EXIT=0, 27/27, covering smoke 3, youtube-smoke 2, party-flow 8, sync-tolerance 6, sync-sustained 1, public-origin 6 and youtube-real-create 1. youtube_real_smoke and youtube_real_create both **passed** (neither was UNTESTED). |
| matrix_covers_every_acceptance | pass | proof-matrix-check.log: 39/39 spec criteria have exactly one row each, every row has a valid status and non-empty evidence, and the keys are exactly {requirement, acceptance, status, evidence}. Script: artifacts/T17/check-matrix.mjs. |
| manual_review_of_host_guide | pass | proof-host-guide.log: rehearsals A (EXIT=0), B (fake cloudflared, EXIT=4) and C (missing tool, EXIT=2) match the guide's expected output line for line. |
| human_tests_listed | pass | The matrix has H1 and H2 rows with status `untested` and an owner noted. |
| r1_1_real_youtube_default_settings | pass | Default Chromium, no `grantPermissions`. Standalone run: `YT_DIAG createMs=66 serverCreates=1 lnaConsoleLines=0 workers=[chrome-extension://<id>/background.js, https://www.youtube.com/sw.js]`. test:e2e run: createMs=61, serverCreates=1. The test asserts that the extension's background.js service worker exists. The dist-test check shows the WebSocket only in background.js. `artifacts/T15/probes/yt-create-probe.mjs` was not reused. |
| public_origin_e2e_graded | pass (see the guard ruling) | public-origin 6/6 in both the standalone and the test:e2e runs: guard, create (elapsedMs 91/81, serverCreates=1, 0 LNA lines), join/tab-close, idle (75 s, socketCloses=0), refused (exact CONNECT_REFUSED text) and reachable-http-rejects (exact CONNECT_REJECTED text for both a plain HTTP server and the /wrong path; no 'Local Network Access' claim; 0 creates). Red before the fix: `artifacts/T16b/red-eb527ba-create-attempt1.log` shows EXIT=1, `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`, `serverCreates=0` and the old generic popup text 'Could not connect to the server.' |
| r1_1_untested_risks_recorded | pass | See Residual risks. |
| status_counts_separate | pass | Verdict table above; repaired commit 5d741a2. |
| no_product_code_edits | pass | `git diff --name-only 5d741a2..<QA commit>` lists only docs/qa/m1-qa-report.md and docs/qa/m1-qa-matrix.json (recorded in result.txt). |

## Ruling on the T16b DISCREPANCY: e2e_public_origin_guard_reproduces_block

The contract says: "fires error before open and the server receives 0 connections from it, proving the page is treated as public."

I observed the same result in all three of my runs (public-origin-attempt1, unit-workspaces-attempt1, test-e2e-attempt1): `firstEvent=error lnaConsoleLines=1 tcpConnections=1 requests=0 upgrades=0 serverCreates=0`, plus a page console line `net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`. This matches T16b's green-guard-attempt3.log.

I also read `e2e/support/party.ts` `startCountingProxy`. The proxy counts a connection when its TCP listener accepts one, and counts a request only when that connection sends at least one byte. So the counted connection carried no bytes: no HTTP request and no WebSocket handshake was sent.

**Ruling: accepted as passed with a recorded wording deviation. The test is not marked failed.** The contract's stated purpose is to prove that the page is treated as public. That is proved directly: the error fired before open, Chromium's own LNA block appeared in the console, and no HTTP request, no upgrade and no create reached the server. The literal phrase "0 connections" is not met at the TCP level (1 accept carrying no bytes). It is met at the HTTP and WebSocket level, which is what "connection" means for a WebSocket server. Two further points:

- The proxy opens its own upstream TCP socket to the sync server for every accept. So even at the TCP level, the sync server's "connection" from this test is an artifact of the proxy, not of the page.
- The cause of the bare TCP accept (Chromium connecting before the LNA check, or preconnecting) remains **unverified**. I collected no evidence on it.

Recommendation for Captain: if the contract is revised, change "0 connections" to "0 HTTP requests / WebSocket handshakes". No product change is needed. This ruling does not change any matrix status.

## Sync measurements (fixture page + 150±50 ms delay proxy, limit 2.0 s)

From the test:e2e run (`artifacts/T17/sync-e2e/sync-report.json`):

| Scenario | max abs diff | samples |
|---|---|---|
| after play | 0.276 s | 41 |
| after pause | 0.054 s | 41 |
| after seek | 0.198 s | 41 |
| late join (30 s in) | 0.215 s | 41 |
| after guest buffering | 0.264 s | 41 |
| after host buffering | 0.424 s | 41 |
| sustained 5 min | 0.300 s | 301 |

The workspaces run passed the same 7 checks. Its report file was overwritten by the test:e2e run, so only that run's pass/fail result is retained, not its maxima.

## Observations (not failures)

1. **youtube_real_create was skipped once.** In the `npm test --workspaces` run (09:38 UTC) it was reported as skipped. The list reporter does not print the skip reason, and the spec skips only on an UNTESTED condition (youtube.com unreachable, or redirected away from /watch). Two minutes earlier the same spec passed standalone, and ten minutes later it passed inside test:e2e. youtube_real_smoke in that same workspaces run passed on real youtube.com. The skip is most likely a transient navigation timeout or consent redirect, but this is **unverified**. The skip is not counted as a pass. The R1.1 grade rests on the two passing runs.
2. The R1.5 prefill and R6.4 Shadow DOM real-Chromium probes come from T15 at eb527ba and were not re-run. `git diff eb527ba..5d741a2` touches no sidebar or invite source (repair-diff-stat.log). R6.3 still has jsdom unit evidence only.
3. R3.1 coverage gap carried over from T15: a guest-issued action is exercised with only 1 guest.
4. `--tunnel none` without `--lan` prints `ws://127.0.0.1`. R8.2 says "the LAN address"; the guide documents that `--lan` is needed for that. This is consistent with the guide.
5. The Windows and macOS host-guide steps were not executed; QA ran on Linux only.
6. Netflix watch pages were not exercised for R1.1. The service-worker transport should avoid the page-origin LNA block there too, but only H1 can confirm it.

## Residual risks (untested; neither changes an R1-R9 matrix status by itself)

- **Sync server on a LAN private address** (for example `ws://192.168.x.x:8787/ws` from `test01-host --tunnel none --lan`): untested. The factory sandbox has only loopback and no second LAN host. Chromium LNA treats the loopback and private address spaces separately, so loopback evidence does not transfer to LAN addresses. Only a human can confirm this case.
- **Long service-worker lifetimes**: zero-traffic idle longer than 45 s, and paused parties longer than the 75 s `e2e_public_origin_idle_survives` window, are untested. The probe measured 45 s with no frames and the bounded e2e measured 75 s (socketCloses=0). Longer lifetimes were not run. If the service worker is terminated, the party ends ('The party connection was lost...'), and there is no automatic reconnect.
- Future Chrome versions could stop exempting extension service workers from LNA. That would surface as CONNECT_REJECTED or CONNECT_REFUSED.

## Human acceptance (not performed by QA)

- **H1: real Netflix.** Owner: a human tester with a Netflix account, at the CP1 review (planned 2026-11-04). Status: untested.
- **H2: real cross-network cloudflared tunnel.** Owner: a human host plus a guest on a different network, at the CP1 review. Status: untested.
