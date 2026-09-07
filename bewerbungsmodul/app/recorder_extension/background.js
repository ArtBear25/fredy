/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */
/* global chrome, RECORDER_CONFIG, importScripts */
importScripts('settings.js');

// Serialize browser events so field changes cannot overtake the following click.
let delivery = Promise.resolve();
const request = async (path, body) => {
  const response = await fetch(`${RECORDER_CONFIG.endpoint}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RECORDER_CONFIG.token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`Recorder HTTP ${response.status}`);
  return response.json();
};

const framePath = async (sender) => {
  if (!sender.frameId) return [];
  const frames = await chrome.webNavigation.getAllFrames({ tabId: sender.tab.id });
  let current = frames.find((frame) => frame.frameId === sender.frameId);
  const path = [];
  while (current && current.parentFrameId !== -1) {
    const target = await chrome.tabs.sendMessage(
      sender.tab.id,
      { kind: 'recorder-frame-target', url: current.url },
      { frameId: current.parentFrameId },
    );
    if (!target) throw new Error('Frame konnte nicht eindeutig zugeordnet werden');
    path.unshift(target);
    current = frames.find((frame) => frame.frameId === current.parentFrameId);
  }
  return path;
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.kind !== 'bewerbungsmodul-recorder' || !sender.tab) return false;
  delivery = delivery
    .catch(() => {})
    .then(async () => {
      const session = await request('/api/v1/recorder/session');
      if (!session.active) return { ok: true, active: false };
      if (message.event.action === 'ready' && sender.frameId) return { ok: true };
      const event = {
        ...message.event,
        session_id: session.session_id,
        tab_id: sender.tab.id,
        opener_tab_id: sender.tab.openerTabId ?? null,
        url: sender.url,
      };
      try {
        event.frame_path = await framePath(sender);
      } catch (error) {
        event.action = 'error';
        event.value = error.message;
      }
      await request('/api/v1/recorder/events', event);
      return { ok: true, active: true };
    });
  delivery.then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
