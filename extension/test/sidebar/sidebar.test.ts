// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessageWire, ParticipantWire } from '@test01/protocol';
import { mountSidebar, type SidebarController, type SidebarHandlers } from '../../src/sidebar/sidebar.js';

function makeHandlers() {
  return {
    onSendChat: vi.fn<(text: string) => void>(),
    onSetMode: vi.fn<(mode: 'everyone' | 'host_only') => void>(),
    onLeave: vi.fn<() => void>(),
  } satisfies SidebarHandlers;
}

function shadow(): ShadowRoot {
  const host = document.querySelector('test01-sidebar');
  if (!host || !host.shadowRoot) throw new Error('sidebar host or shadow root missing');
  return host.shadowRoot;
}

function q<T extends Element>(selector: string): T {
  const el = shadow().querySelector<T>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
}

function pressEnter(input: HTMLInputElement): void {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}

const participants: ParticipantWire[] = [
  { id: 'p-host', nickname: 'Alice', isHost: true, joinedAtServerMs: 1 },
  { id: 'p-self', nickname: 'Bob', isHost: false, joinedAtServerMs: 2 },
  { id: 'p-other', nickname: 'Carol', isHost: false, joinedAtServerMs: 3 },
];

describe('sidebar', () => {
  let handlers: ReturnType<typeof makeHandlers>;
  let sidebar: SidebarController;

  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    handlers = makeHandlers();
    sidebar = mountSidebar(document, handlers);
  });

  afterEach(() => {
    sidebar.destroy();
  });

  it('renders_participants_with_host_badge', () => {
    sidebar.setParticipants(participants, 'p-self', 'p-host');
    const rows = shadow().querySelectorAll('[data-participant-id]');
    expect(rows).toHaveLength(3);
    const host = q<HTMLElement>('[data-participant-id="p-host"]');
    const self = q<HTMLElement>('[data-participant-id="p-self"]');
    const other = q<HTMLElement>('[data-participant-id="p-other"]');
    expect(host.textContent).toContain('Alice');
    expect(host.textContent).toContain('Host');
    expect(self.textContent).toContain('Bob');
    expect(self.textContent).toContain('(you)');
    expect(self.textContent).not.toContain('Host');
    expect(other.textContent).not.toContain('Host');
    expect(other.textContent).not.toContain('(you)');

    // Re-render replaces rows rather than appending.
    sidebar.setParticipants(participants.slice(0, 2), 'p-self', 'p-self');
    expect(shadow().querySelectorAll('[data-participant-id]')).toHaveLength(2);
    expect(q<HTMLElement>('[data-participant-id="p-self"]').textContent).toContain('Host');
  });

  it('chat_rendered_as_text', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const msg: ChatMessageWire = {
      id: 'AAAAAAAAAAAAAAAA',
      participantId: 'p-other',
      nickname: '<b>Carol</b>',
      text: payload,
      sentAtServerMs: 10,
    };
    sidebar.appendChat(msg);
    const log = q<HTMLElement>('.chat-log');
    expect(log.textContent).toContain(payload);
    expect(log.textContent).toContain('<b>Carol</b>');
    expect(shadow().querySelector('img')).toBeNull();
    expect(shadow().querySelector('b')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });

  it('send_chat_trims_and_calls_handler', () => {
    const input = q<HTMLInputElement>('input.chat-input');
    input.value = '  hello ';
    pressEnter(input);
    expect(handlers.onSendChat).toHaveBeenCalledTimes(1);
    expect(handlers.onSendChat).toHaveBeenCalledWith('hello');
    expect(input.value).toBe('');
  });

  it('blank_or_long_chat_not_sent', () => {
    const input = q<HTMLInputElement>('input.chat-input');
    expect(input.maxLength).toBe(500);
    expect(input.getAttribute('maxlength')).toBe('500');
    input.value = '   ';
    pressEnter(input);
    expect(handlers.onSendChat).not.toHaveBeenCalled();
    // A programmatic value can bypass maxlength; it must still not be sent.
    input.value = 'x'.repeat(501);
    pressEnter(input);
    expect(handlers.onSendChat).not.toHaveBeenCalled();
    input.value = ` ${'y'.repeat(500)} `;
    pressEnter(input);
    expect(handlers.onSendChat).toHaveBeenCalledWith('y'.repeat(500));
  });

  it('mode_switch_visible_only_to_host', () => {
    const sw = q<HTMLElement>('.mode-switch');
    const label = q<HTMLElement>('.mode-label');
    sidebar.setMode('everyone', false);
    expect(sw.hidden).toBe(true);
    expect(label.hidden).toBe(false);
    expect(label.textContent).toMatch(/everyone/i);
    sidebar.setMode('everyone', true);
    expect(sw.hidden).toBe(false);
    sidebar.setMode('host_only', false);
    expect(sw.hidden).toBe(true);
    expect(label.textContent).toMatch(/host/i);
  });

  it('mode_switch_calls_handler', () => {
    sidebar.setMode('everyone', true);
    const toggle = q<HTMLInputElement>('.mode-switch input[type="checkbox"]');
    expect(toggle.checked).toBe(false);
    toggle.click();
    expect(handlers.onSetMode).toHaveBeenCalledTimes(1);
    expect(handlers.onSetMode).toHaveBeenCalledWith('host_only');
    // Server confirmation updates the switch without re-invoking the handler.
    sidebar.setMode('host_only', true);
    expect(toggle.checked).toBe(true);
    expect(handlers.onSetMode).toHaveBeenCalledTimes(1);
    toggle.click();
    expect(handlers.onSetMode).toHaveBeenLastCalledWith('everyone');
  });

  it('collapse_expand_does_not_touch_video', () => {
    const video = document.createElement('video');
    document.body.appendChild(video);
    const pausedBefore = video.paused;
    const timeBefore = video.currentTime;
    const seen: string[] = [];
    const mediaEvents = ['play', 'pause', 'playing', 'seeking', 'seeked', 'timeupdate', 'ratechange', 'volumechange', 'click', 'keydown'];
    for (const type of mediaEvents) video.addEventListener(type, () => seen.push(type));
    const playSpy = vi.spyOn(video, 'play');
    const pauseSpy = vi.spyOn(video, 'pause');

    expect(sidebar.isCollapsed()).toBe(false);
    sidebar.collapse();
    expect(sidebar.isCollapsed()).toBe(true);
    expect(q<HTMLElement>('.panel').classList.contains('collapsed')).toBe(true);
    sidebar.expand();
    expect(sidebar.isCollapsed()).toBe(false);
    // The header toggle button collapses too.
    q<HTMLButtonElement>('button.toggle').click();
    expect(sidebar.isCollapsed()).toBe(true);
    q<HTMLButtonElement>('button.toggle').click();
    expect(sidebar.isCollapsed()).toBe(false);

    expect(video.paused).toBe(pausedBefore);
    expect(video.currentTime).toBe(timeBefore);
    expect(seen).toEqual([]);
    expect(playSpy).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(handlers.onSendChat).not.toHaveBeenCalled();
    expect(handlers.onSetMode).not.toHaveBeenCalled();
  });

  it('shadow_root_isolated', () => {
    const style = document.createElement('style');
    style.textContent = 'div{display:none!important}';
    document.head.appendChild(style);
    sidebar.setParticipants(participants, 'p-self', 'p-host');

    // jsdom limitation: its getComputedStyle cascades document sheets onto shadow-tree elements
    // (jsdom/lib/jsdom/living/css/helpers/computed-style.js collects only ownerDocument.styleSheets),
    // so isolation is asserted through selector scoping, which jsdom does model.
    const host = document.querySelector('test01-sidebar') as HTMLElement;
    expect(host.shadowRoot).not.toBeNull();
    expect(host.tagName).not.toBe('DIV');
    expect(getComputedStyle(host).display).not.toBe('none');
    expect(host.children).toHaveLength(0);

    const shadowDivs = Array.from(shadow().querySelectorAll('div'));
    expect(shadowDivs.length).toBeGreaterThan(0);
    expect(shadowDivs.some((d) => d.classList.contains('panel'))).toBe(true);
    // The page rule's selector, evaluated in the document scope, reaches none of the sidebar contents.
    const pageMatches = Array.from(document.querySelectorAll('div'));
    for (const div of shadowDivs) expect(pageMatches).not.toContain(div);
    expect(document.querySelector('.panel, .chat-log, .participants, [data-participant-id]')).toBeNull();
    // The sidebar's own stylesheet lives inside the shadow root.
    expect(shadow().querySelector('style')?.textContent).toContain('.panel');

    // Control: the same rule does hide a light-DOM div.
    const pageDiv = document.createElement('div');
    document.body.appendChild(pageDiv);
    expect(getComputedStyle(pageDiv).display).toBe('none');
    expect(Array.from(document.querySelectorAll('div'))).toContain(pageDiv);
  });

  it('leave_button_and_status_and_destroy (extra)', () => {
    sidebar.setStatus('Connected');
    expect(q<HTMLElement>('.status').textContent).toBe('Connected');
    q<HTMLButtonElement>('button.leave').click();
    expect(handlers.onLeave).toHaveBeenCalledTimes(1);
    sidebar.destroy();
    expect(document.querySelector('test01-sidebar')).toBeNull();
    sidebar.destroy();
  });
});
