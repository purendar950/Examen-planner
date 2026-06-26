export function qs(selector, root = document) {
  return root.querySelector(selector);
}

export function qsa(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function setText(selectorOrElement, value) {
  const element = typeof selectorOrElement === 'string' ? qs(selectorOrElement) : selectorOrElement;
  if (element) element.textContent = value ?? '';
  return element;
}

export function on(selectorOrElement, eventName, handler, options) {
  const element = typeof selectorOrElement === 'string' ? qs(selectorOrElement) : selectorOrElement;
  if (!element) return () => {};
  element.addEventListener(eventName, handler, options);
  return () => element.removeEventListener(eventName, handler, options);
}

export function renderHtml(selectorOrElement, html) {
  const element = typeof selectorOrElement === 'string' ? qs(selectorOrElement) : selectorOrElement;
  if (element) element.innerHTML = html;
  return element;
}
