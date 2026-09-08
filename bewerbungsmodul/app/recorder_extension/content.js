/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */
/* global chrome */
(() => {
  const stable = (value) => {
    if (!value || value.length > 90) return false;
    if (/\d{7,}/.test(value) || /[a-f0-9]{12,}/i.test(value)) return false;
    return true;
  };

  const quoteXPath = (value) => {
    if (!value.includes("'")) return `'${value}'`;
    if (!value.includes('"')) return `"${value}"`;
    return `concat('${value.replaceAll("'", "',\"'\",'")}')`;
  };

  const cssPath = (element) => {
    const parts = [];
    let node = element;
    while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
      let part = node.tagName.toLowerCase();
      if (stable(node.id)) {
        part += `#${CSS.escape(node.id)}`;
        parts.unshift(part);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const peers = [...parent.children].filter((item) => item.tagName === node.tagName);
        if (peers.length > 1) part += `:nth-of-type(${peers.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  };

  const labelText = (element) => {
    if (element.labels && element.labels.length) return element.labels[0].innerText.trim();
    const wrapping = element.closest('label');
    if (wrapping) return wrapping.innerText.trim();
    const labelled = element.getAttribute('aria-labelledby');
    if (labelled) {
      return labelled
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText || '')
        .join(' ')
        .trim();
    }
    return element.getAttribute('aria-label') || element.placeholder || element.innerText?.trim() || '';
  };

  const candidates = (element) => {
    const result = [];
    const add = (strategy, value, score) => {
      if (value && !result.some((item) => item.strategy === strategy && item.value === value)) {
        result.push({ strategy, value, score });
      }
    };
    for (const attribute of ['data-testid', 'data-test', 'data-qa', 'data-cy']) {
      const value = element.getAttribute(attribute);
      if (stable(value)) add('testid', `${attribute}=${value}`, 100);
    }
    if (stable(element.id)) add('id', element.id, 98);
    if (stable(element.getAttribute('name'))) add('name', element.getAttribute('name'), 94);
    const label = labelText(element);
    if (label) add('label', label.slice(0, 160), 88);
    const role = element.getAttribute('role') || { BUTTON: 'button', A: 'link' }[element.tagName];
    if (role && label) add('role', `${role}|${label.slice(0, 160)}`, 82);
    add('css', cssPath(element), 40);
    if (element.id) add('xpath', `//*[@id=${quoteXPath(element.id)}]`, 25);
    return result.sort((a, b) => b.score - a.score);
  };

  let recorderNotice;
  const showRecorderNotice = (kind, text) => {
    if (!document.documentElement) return;
    if (!recorderNotice) {
      recorderNotice = document.createElement('div');
      recorderNotice.id = 'fredy-recorder-status';
      Object.assign(recorderNotice.style, {
        position: 'fixed',
        top: '12px',
        right: '12px',
        zIndex: '2147483647',
        maxWidth: '360px',
        padding: '10px 12px',
        borderRadius: '8px',
        font: '600 13px/1.35 system-ui, sans-serif',
        boxShadow: '0 6px 24px rgba(0,0,0,.22)',
        pointerEvents: 'none',
      });
      document.documentElement.appendChild(recorderNotice);
    }
    recorderNotice.textContent = text;
    recorderNotice.style.background = kind === 'error' ? '#7f1d1d' : '#14532d';
    recorderNotice.style.color = '#fff';
  };

  const recorderErrorText = (error) => {
    const detail = String(error || 'unbekannter Fehler');
    if (detail.includes('401')) {
      return 'Fredy Recorder: Verbindung abgelaufen. Aufnahme in Fredy verwerfen und neu starten.';
    }
    return `Fredy Recorder: Verbindung unterbrochen (${detail}). Nicht weiter ausfüllen.`;
  };

  const send = (event) =>
    chrome.runtime
      .sendMessage({
        kind: 'bewerbungsmodul-recorder',
        event: {
          ...event,
          url: location.href,
          title: document.title,
          timestamp: new Date().toISOString(),
        },
      })
      .then((response) => {
        if (!response?.ok) {
          showRecorderNotice('error', recorderErrorText(response?.error));
          return false;
        }
        if (response.active === false) {
          recorderNotice?.remove();
          recorderNotice = undefined;
          return false;
        }
        if (response.active) showRecorderNotice('ok', 'Fredy Recorder aktiv');
        return response.active === true;
      })
      .catch((error) => {
        showRecorderNotice('error', recorderErrorText(error?.message));
        return false;
      });

  const target = (element) => ({
    candidates: candidates(element),
    tag: element.tagName.toLowerCase(),
    label: labelText(element).slice(0, 160),
    input_type: element.type || element.getAttribute('type'),
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.kind !== 'recorder-frame-target') return false;
    const frames = [...document.querySelectorAll('iframe, frame')].filter(
      (frame) => frame.src === message.url || (frame.src === '' && message.url === 'about:blank'),
    );
    sendResponse(frames.length === 1 ? target(frames[0]) : null);
    return false;
  });
  const ready = async () => {
    if (window.top !== window) return;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (await send({ action: 'ready' })) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', ready, { once: true });
  else ready();

  addEventListener(
    'click',
    (event) => {
      if (!event.isTrusted) return;
      const element = event.target.closest('button, a, [role=button], input[type=submit], input[type=button]');
      if (!element) return;
      send({
        action: 'click',
        target: target(element),
        value: null,
        redacted: false,
        opens_new_tab: element.getAttribute('target') === '_blank',
      });
    },
    true,
  );

  addEventListener(
    'change',
    (event) => {
      if (!event.isTrusted) return;
      const element = event.target;
      if (!(
        element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement
      ))
        return;
      let action = 'fill';
      let value = element.value;
      if (element instanceof HTMLSelectElement) action = 'select';
      if (element.type === 'checkbox' || element.type === 'radio') {
        action = 'check';
        value = element.checked;
      }
      if (element.type === 'file') {
        action = 'upload';
        value = null;
      }
      const redacted = element.type === 'password';
      send({ action, target: target(element), value: redacted ? null : value, redacted });
    },
    true,
  );
})();
