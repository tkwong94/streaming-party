// Exposes window.__fixture = { video, ready, stall(ms) } for e2e tests and the fixture adapter.
(() => {
  const video = document.getElementById('fixture-video');

  const ready = new Promise((resolve, reject) => {
    if (video.readyState >= 1 && Number.isFinite(video.duration)) {
      resolve();
      return;
    }
    video.addEventListener('loadedmetadata', () => resolve(), { once: true });
    video.addEventListener('error', () => reject(new Error('fixture video failed to load')), { once: true });
  });

  // Simulates a buffering stall: pause, dispatch 'waiting', wait ms, then resume.
  // Resuming via play() fires the native 'playing' event before the play() promise resolves.
  async function stall(ms) {
    await ready;
    video.pause();
    video.dispatchEvent(new Event('waiting'));
    await new Promise((r) => setTimeout(r, ms));
    await video.play();
  }

  window.__fixture = { video, ready, stall };
})();
