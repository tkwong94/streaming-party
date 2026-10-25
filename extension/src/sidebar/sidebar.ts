import type { ChatMessageWire, ControlMode, ParticipantWire } from '@test01/protocol';
import { SIDEBAR_CSS } from './styles.js';

export const SIDEBAR_TAG = 'test01-sidebar';
export const CHAT_MAX_LENGTH = 500;

export interface SidebarHandlers {
  onSendChat(text: string): void;
  onSetMode(mode: ControlMode): void;
  onLeave(): void;
}

export interface SidebarController {
  setParticipants(list: ParticipantWire[], selfId: string, hostId: string): void;
  appendChat(msg: ChatMessageWire): void;
  setMode(mode: ControlMode, isHost: boolean): void;
  setStatus(text: string): void;
  collapse(): void;
  expand(): void;
  isCollapsed(): boolean;
  destroy(): void;
}

// All user-supplied strings (nicknames, chat text) are written with textContent only.
function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function mountSidebar(doc: Document, handlers: SidebarHandlers): SidebarController {
  const host = doc.createElement(SIDEBAR_TAG);
  const root = host.attachShadow({ mode: 'open' });

  const style = el(doc, 'style');
  style.textContent = SIDEBAR_CSS;

  const panel = el(doc, 'div', 'panel');
  const header = el(doc, 'div', 'header');
  const toggle = el(doc, 'button', 'toggle', '⟩');
  toggle.type = 'button';
  toggle.title = 'Collapse sidebar';
  const title = el(doc, 'span', 'title', 'Watch party');
  const leave = el(doc, 'button', 'leave', 'Leave');
  leave.type = 'button';
  header.append(toggle, title, leave);

  const body = el(doc, 'div', 'body');
  const status = el(doc, 'div', 'status');

  const modeRow = el(doc, 'div', 'mode');
  const modeLabel = el(doc, 'span', 'mode-label', 'Control: everyone');
  const modeSwitch = el(doc, 'label', 'mode-switch');
  const modeCheckbox = el(doc, 'input');
  modeCheckbox.type = 'checkbox';
  modeSwitch.append(modeCheckbox, doc.createTextNode(' Host only'));
  modeSwitch.hidden = true;
  modeRow.append(modeLabel, modeSwitch);

  const list = el(doc, 'ul', 'participants');
  const chatLog = el(doc, 'div', 'chat-log');
  const chatInput = el(doc, 'input', 'chat-input');
  chatInput.type = 'text';
  chatInput.maxLength = CHAT_MAX_LENGTH;
  chatInput.placeholder = 'Say something…';

  body.append(status, modeRow, list, chatLog, chatInput);
  panel.append(header, body);
  root.append(style, panel);
  (doc.body ?? doc.documentElement).appendChild(host);

  let collapsed = false;
  let currentMode: ControlMode = 'everyone';
  let destroyed = false;

  // Collapse/expand only toggles a class inside the shadow root; it never touches page media.
  const setCollapsed = (value: boolean): void => {
    collapsed = value;
    panel.classList.toggle('collapsed', value);
    toggle.textContent = value ? '⟨' : '⟩';
    toggle.title = value ? 'Expand sidebar' : 'Collapse sidebar';
  };

  // Keep keystrokes typed into the sidebar from reaching page shortcuts (e.g. space = play/pause).
  const stopKeys = (e: Event): void => e.stopPropagation();
  for (const type of ['keydown', 'keyup', 'keypress'] as const) chatInput.addEventListener(type, stopKeys);

  chatInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    const text = chatInput.value.trim();
    if (text.length === 0 || text.length > CHAT_MAX_LENGTH) return;
    chatInput.value = '';
    handlers.onSendChat(text);
  });

  modeCheckbox.addEventListener('change', () => {
    const requested: ControlMode = modeCheckbox.checked ? 'host_only' : 'everyone';
    // Show the confirmed mode until the server broadcasts the change.
    modeCheckbox.checked = currentMode === 'host_only';
    handlers.onSetMode(requested);
  });

  toggle.addEventListener('click', () => setCollapsed(!collapsed));
  leave.addEventListener('click', () => handlers.onLeave());

  return {
    setParticipants(participants, selfId, hostId) {
      const rows = participants.map((p) => {
        const row = el(doc, 'li');
        row.dataset.participantId = p.id;
        row.append(el(doc, 'span', 'nick', p.nickname));
        if (p.id === hostId) row.append(el(doc, 'span', 'badge', 'Host'));
        if (p.id === selfId) row.append(el(doc, 'span', 'you', '(you)'));
        return row;
      });
      list.replaceChildren(...rows);
    },
    appendChat(msg) {
      const row = el(doc, 'div', 'chat-msg');
      row.dataset.messageId = msg.id;
      row.append(el(doc, 'span', 'chat-nick', msg.nickname), el(doc, 'span', 'chat-text', msg.text));
      const atBottom = chatLog.scrollTop + chatLog.clientHeight >= chatLog.scrollHeight - 4;
      chatLog.append(row);
      if (atBottom) chatLog.scrollTop = chatLog.scrollHeight;
    },
    setMode(mode, isHost) {
      currentMode = mode;
      modeLabel.textContent = mode === 'host_only' ? 'Control: host only' : 'Control: everyone';
      modeCheckbox.checked = mode === 'host_only';
      modeSwitch.hidden = !isHost;
    },
    setStatus(text) {
      status.textContent = text;
    },
    collapse() {
      setCollapsed(true);
    },
    expand() {
      setCollapsed(false);
    },
    isCollapsed() {
      return collapsed;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      host.remove();
    },
  };
}
