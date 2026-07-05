/**
 * Navigation helpers for Kuratchi routes.
 * Import via: import { redirect, navigateTo } from 'koze:navigation';
 *
 * redirect() is server-side. It throws a RedirectError that the framework
 * catches and converts to an HTTP redirect response.
 *
 * navigateTo() is browser-side. It fetches same-origin HTML, updates history,
 * swaps the document, and falls back to normal browser navigation if the client
 * fetch cannot produce an HTML page.
 */

export { redirect } from './context.js';

export interface NavigateToOptions {
  replace?: boolean;
}

let popstateInstalled = false;
let currentNavigation: AbortController | null = null;

export async function navigateTo(path: string, options: NavigateToOptions = {}): Promise<void> {
  if (typeof window === 'undefined') return;
  const target = new URL(path, window.location.href);
  if (target.origin !== window.location.origin) {
    fallbackNavigate(target.href, options.replace);
    return;
  }

  installPopstateHandler();

  try {
    await loadDocument(target, options.replace ? 'replace' : 'push');
  } catch {
    fallbackNavigate(target.href, options.replace);
  }
}

export async function refreshRoute(): Promise<void> {
  if (typeof window === 'undefined') return;
  await navigateTo(window.location.href, { replace: true });
}

function installPopstateHandler(): void {
  if (popstateInstalled || typeof window === 'undefined') return;
  popstateInstalled = true;
  window.addEventListener('popstate', () => {
    const target = new URL(window.location.href);
    loadDocument(target, 'none').catch(() => window.location.reload());
  });
}

async function loadDocument(target: URL, historyMode: 'push' | 'replace' | 'none'): Promise<void> {
  if (typeof window === 'undefined') return;
  currentNavigation?.abort();
  const controller = new AbortController();
  currentNavigation = controller;

  const response = await fetch(target.href, {
    credentials: 'same-origin',
    headers: { 'x-koze-navigation': '1' },
    signal: controller.signal,
  });
  if (currentNavigation === controller) currentNavigation = null;

  const contentType = response.headers.get('content-type')?.toLowerCase() || '';
  if (!response.ok || !contentType.includes('text/html')) {
    throw new Error(`Navigation failed: HTTP ${response.status}`);
  }

  const html = await response.text();
  const finalUrl = response.url || target.href;
  commitHistory(finalUrl, historyMode);
  replaceDocument(html);
  window.dispatchEvent(new CustomEvent('koze:navigation', {
    detail: { url: finalUrl, mode: historyMode },
  }));
}

function commitHistory(url: string, mode: 'push' | 'replace' | 'none'): void {
  if (typeof window === 'undefined' || mode === 'none') return;
  const state = { ...(window.history.state || {}), __koze: true };
  if (mode === 'replace') window.history.replaceState(state, '', url);
  else window.history.pushState(state, '', url);
}

function replaceDocument(html: string): void {
  const doc = window.document;
  doc.open();
  doc.write(html);
  doc.close();
}

function fallbackNavigate(path: string, replace?: boolean): void {
  if (replace) window.location.replace(path);
  else window.location.assign(path);
}
