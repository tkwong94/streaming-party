// Styles live inside the sidebar's shadow root, so page CSS cannot restyle them
// and these rules cannot leak into the page.
export const SIDEBAR_WIDTH_PX = 300;

export const SIDEBAR_CSS = `
:host {
  all: initial;
  position: fixed;
  top: 0;
  right: 0;
  height: 100vh;
  z-index: 2147483647;
  display: block;
  font: 13px/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  color: #eee;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.panel {
  display: flex;
  flex-direction: column;
  width: ${SIDEBAR_WIDTH_PX}px;
  height: 100%;
  background: rgba(20, 20, 24, 0.95);
  border-left: 1px solid #333;
}
.panel.collapsed { width: 36px; }
.panel.collapsed .body { display: none; }
.header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px;
  border-bottom: 1px solid #333;
}
.title { flex: 1; font-weight: 600; }
.panel.collapsed .title { display: none; }
.body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding: 6px;
  gap: 8px;
}
.status { color: #aaa; font-size: 12px; }
.mode { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.participants { list-style: none; margin: 0; padding: 0; max-height: 30%; overflow-y: auto; }
.participants li { display: block; padding: 2px 0; }
.badge { margin-left: 4px; padding: 0 4px; border-radius: 3px; background: #e50914; color: #fff; font-size: 11px; }
.you { margin-left: 4px; color: #aaa; }
.chat-log { flex: 1; min-height: 0; overflow-y: auto; word-break: break-word; }
.chat-msg { display: block; padding: 2px 0; }
.chat-nick { font-weight: 600; margin-right: 4px; }
.chat-input { width: 100%; padding: 6px; border: 1px solid #444; border-radius: 4px; background: #111; color: #eee; }
button { cursor: pointer; background: #333; color: #eee; border: 1px solid #555; border-radius: 4px; padding: 2px 8px; }
`;
