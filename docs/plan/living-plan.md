# [test-pd-01] test-01 — Living plan

Status: **Draft v4, not approved.** No implementation work has been approved or dispatched.
Last revised: 2026-10-25 (UTC) by Captain.

## 1. What test-01 is

test-01 is a small Chrome extension built entirely by AI Factory. It is a real-but-small project for testing and improving the factory itself.
It works like Teleparty: several people watch the same Netflix or YouTube video at the same time, each using their own streaming account, with playback kept in sync. A later milestone adds real-time bullet-screen (danmaku) comments.

- Product name: **test-01**. Do not use "Streaming party" as a product name.
- Code repository: github.com/tkwong94/streaming-party. The repo name is unchanged; renaming it needs an explicit human request.
- Linear: **no Linear tasks are created for test-01** (D14). The factory binding to project "ai factory" (P-TECH-33) is technical only. If any Linear item is ever created, its title starts with `[test-pd-01]`.
- Plan location: this file, kept locally and committed to the GitHub repo's `main` branch at `docs/plan/living-plan.md` (D14).
- Milestones: tracked **only in this local plan** (decision D1). Factory binding uses the existing "ai factory" milestone "M1 — Docker MVP capability verification" only as a technical anchor (decision D2).

## 2. Reference research: Teleparty (summary, 2026-10-25)

Sources: teleparty.com/support, teleparty.com/netflix, the Chrome Web Store / Edge Add-ons listings, and third-party guides. These are reference material only, not requirements.

- Host opens a video on the streaming site's watch page (e.g. `netflix.com/watch/<id>`), clicks the extension icon, creates a party and copies an invite link. Option: "Only I have control".
- Guest needs the extension and their own access to the service and title. Opening the link redirects to the title; the guest then joins the room.
- Sync: play/pause/seek is propagated through a real-time server (WebSocket-style) to all participants.
- Sidebar text chat, nicknames/avatars, later emoji reactions and GIFs.
- Out of scope by design: sharing accounts, bypassing region/screen limits, streaming video between users. Voice/video is not part of the basic product.

## 3. Milestones (local only)

### test-01 M1 — Watch together (synced playback + sidebar chat) — CURRENT, draft scope
Supported sites: **Netflix and YouTube** (D3, human-confirmed).
Proposed observable outcomes:
1. A user on a supported watch page can create a party and get an invite link.
2. A second user with the extension can open the link and join the same room.
3. Play, pause and seek by an allowed participant are applied to all others; late joiners jump to the room's current position.
4. **Sync tolerance (D8, human requirement):** while playing, every guest stays within **2 seconds** of the host's playback position. After play/pause/seek or a late join, guests converge within the tolerance after a short settle window; a continuous drift check re-aligns any guest that drifts beyond it. Buffering/ad pauses are detected and re-synced, not counted as normal drift.
5. Everyone can control playback by default; the host can switch to "only I control" (D4, human-confirmed).
6. Up to 10 participants per room (D4, human-confirmed). Participant list with nicknames; leaving or closing the tab removes the user.
7. Expandable sidebar with text chat for party members (D5/D9).
8. A small in-memory Node.js sync server that the **party host runs on their own computer**; no cloud server (D6, human-confirmed).
9. **Guided tunnel setup** so guests outside the host's network can join (D7, human-confirmed): one host command starts the sync server and a tunnel, checks it, and prints the public address that the invite link uses. Default tool: Cloudflare Quick Tunnel; ngrok as alternative (D10, reversible). Step-by-step host guide included.

Exclusions for M1: bullet-screen overlay (M2, D9 human-confirmed), Disney+ (M3), voice/video, accounts/login, Chrome Web Store publication, cloud hosting, a test-01-operated relay or domain, mobile apps, non-Chromium browsers.

### test-01 M2 — Real-time bullet-screen comments — LATER
Bilibili-style danmaku: comments typed by party members scroll across the video in real time, built on the M1 room connection. The sidebar chat from M1 remains.

### test-01 M3 — Disney+ support — LATER
Add Disney+ as a third supported site.

## 4. Hosting: host-run sync server with guided tunnel

- A Chrome extension cannot accept incoming connections itself, so the host runs a small Node.js sync server on their own computer.
- Guests on the same network can connect directly.
- For guests on the internet, test-01 ships a host helper that starts the server and a tunnel, verifies it, and prints the public `wss://` address the invite link carries.
- Default tunnel (D10, reversible): **Cloudflare Quick Tunnel** (`cloudflared`). Free and needs no account, but the address changes every run and Cloudflare gives no uptime guarantee. Alternative: ngrok (free account and auth token kept on the host's machine). The host installs the tunnel tool; test-01 never stores or transmits the host's tokens.
- The server address is configurable in the extension, so a cloud host or WebRTC transport can replace this later without changing the room protocol.
- Because the server is exposed to the internet, rooms use unguessable IDs and the invite link carries a room secret; the server rejects joins without it and enforces the 10-person limit.

## 5. How the 2-second tolerance will be met and proven

- Room state carries the authoritative position plus a server timestamp; clients estimate clock offset and network delay to the server so a guest seeks to where the host is *now*, not where it was when the message was sent.
- Each client periodically reports its position; a guest more than the tolerance away is re-aligned (seek), smaller drift is left alone to avoid stutter.
- Automated proof (factory): a local fixture video page plus YouTube, with simulated network delay, measuring host-vs-guest position difference after play, pause, seek, late join and over a sustained playback period. This is fixture/YouTube evidence, **not** Netflix or real-internet acceptance.
- Human proof: a host and a guest on different networks through the tunnel, on Netflix and YouTube, checking the visible position difference.
- Known risk: Netflix's player can error when the page's video element is seeked directly; the Netflix adapter must use a seek method Netflix tolerates. Real Netflix behaviour can only be confirmed by the human test.

## 6. Open questions for the human

None blocking. Defaults applied: tunnel tool Cloudflare Quick Tunnel (D10, reversible).

## 7. Known constraints and gates

- Netflix acceptance needs a human tester with a Netflix account. Automated tests use a local fixture video page and/or YouTube; fixture tests are **not** real Netflix acceptance.
- Real internet tunnel acceptance (including the 2-second tolerance over the internet) needs a human host on a real network plus a guest outside it. Factory tests cover the helper logic and a local loopback path with simulated delay only.
- The tunnel is a third-party service chosen and run by the host; its availability and terms are outside test-01's control.
- The factory's managed infrastructure supports MySQL 8.4 only. M1 needs no database (in-memory rooms).
- GitHub: write access confirmed by the first push to `main` (commit f6b078b5f727fa806d22d30afa0de59bd124bb66: README.md and this plan), authorized by the human (D14).
- Linear write access is not yet proven by a confirmed write; the v1 living-plan save is in an unknown state.

## 8. Checkpoints (D13, supersedes D11)

Three human checkpoints, one per milestone:
- **CP1 = M1** Watch together (synced playback, sidebar chat, host server + tunnel). Current.
- **CP2 = M2** Real-time bullet-screen overlay. Later.
- **CP3 = M3** Disney+. Details decided later.

CP1 v1 (M1 only, older wording) and CP1 v2 (M1 + M2) are withdrawn. CP1 v3 is the version for approval.

M2 bullet-screen defaults for CP2 (D12, reversible): one chat input feeds both the sidebar and the scrolling overlay; per-viewer on/off toggle; works in fullscreen; lanes avoid overlap; player controls stay clickable; 100-character limit; text-only rendering.

## 9. Factory dispatch and Linear (D15, resolved: option b)

The factory's task dispatch tool creates one Linear issue per worker task and currently has no no-Linear mode. Jackie Wong chose (b): keep Linear at zero. Captain will not dispatch test-01 tasks through the Linear-creating path.

- **Enablement dependency:** a factory operator adds a no-Linear dispatch mode. Owner: unassigned. Date: none. Readiness evidence: factory dispatch status shows a no-Linear option for this project.
- **Blocked meanwhile:** dispatch of all M1 worker tasks T01-T15, so no product code, and every CP1 date after the reviewed design is on hold.
- **Continues meanwhile:** design revision, independent review, and Captain approval of the detailed M1 plan (after the human `Approve CP1 v3` is recorded).

## 10. Next steps

1. Push this plan to GitHub `main` (authorized by the human, D14).
2. Human replies `Approve CP1 v3` and resolves the Linear dispatch conflict in section 9.
3. Dedicated design worker writes the detailed M1 spec and tasks; a different worker reviews; tasks are dispatched.
