/* global chrome */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.kind !== 'bewerbungsmodul-recorder') return false;
  fetch('http://127.0.0.1:8765/api/v1/recorder/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message.event),
  })
    .then((response) => sendResponse({ ok: response.ok }))
    .catch(() => sendResponse({ ok: false }));
  return true;
});
