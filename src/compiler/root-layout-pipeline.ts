export interface UiConfigValues {
  theme: string;
  radius: string;
}

const ROOT_HEAD_SLOT = '<!--__KURATCHI_ROOT_HEAD_SLOT__-->';
const ROOT_BODY_SLOT = '<!--__KURATCHI_ROOT_BODY_SLOT__-->';

function insertBeforeClosingTag(source: string, tagName: 'head' | 'body', marker: string): string {
  const lower = source.toLowerCase();
  const closingTag = `</${tagName}>`;
  const idx = lower.lastIndexOf(closingTag);
  if (idx === -1) {
    return tagName === 'head' ? `${marker}\n${source}` : `${source}\n${marker}`;
  }
  return source.slice(0, idx) + marker + '\n' + source.slice(idx);
}

function compactInlineJs(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*([{}();,:])\s*/g, '$1')
    .trim();
}

function patchHtmlTag(source: string, theme: string, radius: string): string {
  return source.replace(/(<html\b)([^>]*)(>)/i, (_match: string, open: string, attrs: string, close: string) => {
    if (theme === 'dark') {
      if (/\bclass\s*=\s*"([^"]*)"/i.test(attrs)) {
        attrs = attrs.replace(/class\s*=\s*"([^"]*)"/i, (_classMatch: string, cls: string) => {
          const classes = cls.split(/\s+/).filter(Boolean);
          if (!classes.includes('dark')) classes.unshift('dark');
          return `class="${classes.join(' ')}"`;
        });
      } else {
        attrs += ' class="dark"';
      }
      attrs = attrs.replace(/\s*data-theme\s*=\s*"[^"]*"/i, '');
    } else if (theme === 'light') {
      attrs = attrs.replace(/class\s*=\s*"([^"]*)"/i, (_classMatch: string, cls: string) => {
        const classes = cls.split(/\s+/).filter(Boolean).filter((className: string) => className !== 'dark');
        return classes.length ? `class="${classes.join(' ')}"` : '';
      });
      attrs = attrs.replace(/\s*data-theme\s*=\s*"[^"]*"/i, '');
    } else if (theme === 'system') {
      attrs = attrs.replace(/class\s*=\s*"([^"]*)"/i, (_classMatch: string, cls: string) => {
        const classes = cls.split(/\s+/).filter(Boolean).filter((className: string) => className !== 'dark');
        return classes.length ? `class="${classes.join(' ')}"` : '';
      });
      if (/data-theme\s*=/i.test(attrs)) {
        attrs = attrs.replace(/data-theme\s*=\s*"[^"]*"/i, 'data-theme="system"');
      } else {
        attrs += ' data-theme="system"';
      }
    }

    attrs = attrs.replace(/\s*data-radius\s*=\s*"[^"]*"/i, '');
    if (radius === 'none' || radius === 'full') {
      attrs += ` data-radius="${radius}"`;
    }

    return open + attrs + close;
  });
}

const BRIDGE_SOURCE = `(function(){
function nearestIslandRoot(node){
  let current = node && node.nodeType === 1 ? node : (node && node.parentElement) ? node.parentElement : null;
  while(current){
    if(current.hasAttribute && current.hasAttribute('data-k-island-root')) return current;
    current = current.parentElement;
  }
  return null;
}
function belongsToMount(node, root){
  var islandRoot = nearestIslandRoot(node);
  if(root && root.nodeType === 1 && root.hasAttribute && root.hasAttribute('data-k-island-root')){
    return islandRoot === root;
  }
  return islandRoot == null;
}
function by(sel, root){
  return Array.prototype.slice.call((root || document).querySelectorAll(sel)).filter(function(node){
    return belongsToMount(node, root || document);
  });
}
  var __clientHandlers = Object.create(null);
  window.__kozeClient = window.__kozeClient || {
    register: function(routeId, handlers){
      if(!routeId || !handlers) return;
      // Validate routeId format (alphanumeric, underscores, hyphens only)
      if(!/^[a-zA-Z0-9_-]+$/.test(String(routeId))) return;
      __clientHandlers[String(routeId)] = Object.assign(__clientHandlers[String(routeId)] || {}, handlers);
    },
    invoke: function(routeId, handlerId, args, event, element){
      // Validate inputs to prevent prototype pollution and injection
      if(!routeId || !handlerId) return;
      var safeRouteId = String(routeId);
      var safeHandlerId = String(handlerId);
      // Block prototype pollution attempts
      if(safeRouteId === '__proto__' || safeRouteId === 'constructor' || safeRouteId === 'prototype') return;
      if(safeHandlerId === '__proto__' || safeHandlerId === 'constructor' || safeHandlerId === 'prototype') return;
      // Validate handler ID format (alphanumeric, underscores only - matches JS identifier rules)
      if(!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(safeHandlerId)) return;
      var routeHandlers = __clientHandlers[safeRouteId] || null;
      if(!routeHandlers || !Object.prototype.hasOwnProperty.call(routeHandlers, safeHandlerId)) return;
      var handler = routeHandlers[safeHandlerId];
      if(typeof handler !== 'function') return;
      return handler(Array.isArray(args) ? args : [], event, element);
    }
  };
  var __actionStates = window.__kozeActions = window.__kozeActions || Object.create(null);
  function defineActionMeta(state, key, value){
    try { Object.defineProperty(state, key, { value: value, enumerable: false, configurable: true, writable: true }); }
    catch(_err){ state[key] = value; }
  }
  window.__kozeAugment = window.__kozeAugment || function(alias, targetName, _target, hooks){
    var initial = { __kozeAction: String(alias || ''), error: undefined, pending: false, success: false };
    var state = window.__kozeReactive && typeof window.__kozeReactive.state === 'function'
      ? window.__kozeReactive.state(initial)
      : initial;
    defineActionMeta(state, '__kozeAction', String(alias || ''));
    defineActionMeta(state, '__kozeTargetAction', String(targetName || ''));
    defineActionMeta(state, '__kozeHooks', hooks && typeof hooks === 'object' ? hooks : {});
    if(alias) __actionStates[String(alias)] = state;
    return state;
  };
  function updateActionState(actionName, patch){
    var state = actionName ? __actionStates[String(actionName)] : null;
    if(!state) return null;
    if(Object.prototype.hasOwnProperty.call(patch, 'error')) state.error = patch.error;
    if(Object.prototype.hasOwnProperty.call(patch, 'pending')) state.pending = !!patch.pending;
    if(Object.prototype.hasOwnProperty.call(patch, 'success')) state.success = !!patch.success;
    return state;
  }
  function callActionHook(state, name, payload){
    var hooks = state && state.__kozeHooks;
    var fn = hooks && hooks[name];
    if(typeof fn !== 'function') return;
    try { fn(payload || {}); }
    catch(err){ console.error('[koze] action hook error:', err); }
  }
  function responseContentType(response){
    return String((response.headers && response.headers.get && response.headers.get('content-type')) || '').toLowerCase();
  }
  function replaceDocument(html, url){
    if(!html){ location.reload(); return; }
    try {
      if(url && window.history && window.history.replaceState) window.history.replaceState(window.history.state, '', url);
    } catch(_err) {}
    if(typeof DOMParser !== 'undefined'){
      try {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        if(doc && doc.body){
          if(doc.title) document.title = doc.title;
          document.body.innerHTML = doc.body.innerHTML;
          syncModalDialogs();
          return;
        }
      } catch(_err) {}
    }
    document.open();
    document.write(html);
    document.close();
    setTimeout(syncModalDialogs, 0);
  }
  function handleActionResponse(response){
    var contentType = responseContentType(response);
    if(response.redirected && response.url){
      location.assign(response.url);
      return Promise.resolve();
    }
    if(contentType.indexOf('application/json') !== -1){
      return response.json().then(function(payload){
        if(!response.ok || (payload && payload.ok === false)){
          throw new Error((payload && payload.error) || ('HTTP ' + response.status));
        }
        if(payload && payload.redirectTo){
          location.assign(payload.redirectTo);
          return;
        }
        location.reload();
      });
    }
    if(contentType.indexOf('text/html') !== -1){
      return response.text().then(function(html){ replaceDocument(html, response.url); });
    }
    if(!response.ok) throw new Error('HTTP ' + response.status);
    location.reload();
    return Promise.resolve();
  }
  function handleStateActionResponse(response, actionName, form){
    if(response.redirected && response.url){
      location.assign(response.url);
      return Promise.resolve();
    }
    var contentType = responseContentType(response);
    if(contentType.indexOf('application/json') === -1){
      return handleActionResponse(response);
    }
    return response.json().then(function(payload){
      var nextAction = (payload && payload.action) || actionName;
      var nextState = payload && payload.state ? payload.state : {
        error: payload && payload.error ? payload.error : undefined,
        pending: false,
        success: !!(payload && payload.ok),
      };
      var state = updateActionState(nextAction, nextState);
      var hookPayload = {
        action: nextAction,
        form: form,
        response: response,
        result: payload && payload.result,
        error: nextState.error,
        redirectTo: payload && payload.redirectTo,
        redirectStatus: payload && payload.redirectStatus
      };
      if(state){
        if(nextState.success) callActionHook(state, 'success', hookPayload);
        else if(nextState.error) callActionHook(state, 'error', hookPayload);
        callActionHook(state, 'settled', hookPayload);
      }
    });
  }
  function formControls(form){
    return Array.prototype.slice.call(form && form.elements ? form.elements : []);
  }
  function formSubmitControls(form){
    return formControls(form).filter(function(control){
      var tag = String(control.tagName || '').toLowerCase();
      if(tag !== 'button' && !(tag === 'input' && String(control.type || '').toLowerCase() === 'submit')) return false;
      var type = String(control.type || 'submit').toLowerCase();
      return type === 'submit' || type === '';
    });
  }
  function formActionName(form){
    var named = form && form.elements && typeof form.elements.namedItem === 'function'
      ? form.elements.namedItem('_action')
      : null;
    if(named){
      if(typeof RadioNodeList !== 'undefined' && named instanceof RadioNodeList) return named.value || '';
      if('value' in named) return named.value || '';
    }
    var aInput = form && form.querySelector ? form.querySelector('input[name="_action"]') : null;
    return aInput ? aInput.value : '';
  }
  function setActionPending(form, actionName){
    form.setAttribute('data-action-pending', actionName);
    formSubmitControls(form).forEach(function(button){
      if(!button.hasAttribute('data-k-was-disabled')) button.setAttribute('data-k-was-disabled', button.disabled ? '1' : '0');
      button.disabled = true;
    });
  }
  function clearActionPending(form){
    form.removeAttribute('data-action-pending');
    formSubmitControls(form).forEach(function(button){
      var wasDisabled = button.getAttribute('data-k-was-disabled') === '1';
      button.disabled = wasDisabled;
      button.removeAttribute('data-k-was-disabled');
    });
  }
  function openModalDialog(dialog){
    if(!dialog) return;
    if(dialog.open) return;
    if(typeof dialog.showModal === 'function'){
      try {
        dialog.showModal();
        return;
      } catch(_err) {}
    }
    dialog.setAttribute('open', '');
  }
  function syncModalDialogs(){
    by('dialog[data-kui-open-modal]').forEach(function(dialog){
      openModalDialog(dialog);
    });
  }
  function actionFormMode(form){
    if(form.hasAttribute('data-action-augment')) return 'state';
    if(form.hasAttribute('augment') || form.hasAttribute('data-augment')) return 'html';
    return '';
  }
  function syncGroup(group){
    var items = by('[data-select-item]').filter(function(el){ return el.getAttribute('data-select-item') === group; });
    var masters = by('[data-select-all]').filter(function(el){ return el.getAttribute('data-select-all') === group; });
    if(!items.length || !masters.length) return;
    var all = items.every(function(i){ return !!i.checked; });
    var any = items.some(function(i){ return !!i.checked; });
    masters.forEach(function(m){ m.checked = all; m.indeterminate = any && !all; });
  }
  function act(e){
    // Per-event handler attribute lookup so multiple on<event>={...}
    // directives on the same element don't collide. See compiler/template.ts.
    var perEventAttr = 'data-cce-' + e.type;
    var clientSel = '[' + perEventAttr + ']';
    var clientEl = e.target && e.target.closest ? e.target.closest(clientSel) : null;
    if(clientEl){
      var routeId = clientEl.getAttribute('data-client-route') || '';
      var handlerId = clientEl.getAttribute(perEventAttr) || '';
      var argsRaw = clientEl.getAttribute('data-cca-' + e.type) || '[]';
      var args = [];
      try {
        var parsedArgs = JSON.parse(argsRaw);
        args = Array.isArray(parsedArgs) ? parsedArgs : [];
      } catch(_err) {}
      try {
        var result = window.__kozeClient && typeof window.__kozeClient.invoke === 'function'
          ? window.__kozeClient.invoke(routeId, handlerId, args, e, clientEl)
          : undefined;
        if(result === false){
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      } catch(err) {
        console.error('[koze] client handler error:', err);
      }
    }
    var sel = '[data-action][data-action-event="' + e.type + '"]';
    var b = e.target && e.target.closest ? e.target.closest(sel) : null;
    if(!b) return;
    e.preventDefault();
    var fd = new FormData();
    fd.append('_action', b.getAttribute('data-action') || '');
    fd.append('_args', b.getAttribute('data-args') || '[]');
    var m = b.getAttribute('data-action-method');
    if(m) fd.append('_method', String(m).toUpperCase());
    fetch(location.pathname, { method: 'POST', body: fd, credentials: 'same-origin' })
      .then(function(r){
        if(!r.ok){
          return r.json().then(function(j){ throw new Error((j && j.error) || ('HTTP ' + r.status)); }).catch(function(){ throw new Error('HTTP ' + r.status); });
        }
        return r.json();
      })
      .then(function(j){
        if(j && j.redirectTo){ location.assign(j.redirectTo); return; }
      })
      .catch(function(err){ console.error('[koze] client action error:', err); });
  }
  ['click','change','input','submit'].forEach(function(ev){ document.addEventListener(ev, act); });
  ['focus','blur'].forEach(function(ev){ document.addEventListener(ev, act, true); });
  document.addEventListener('click', function(e){
    var commandEl = e.target && e.target.closest ? e.target.closest('[command][commandfor]') : null;
    if(commandEl){
      var command = commandEl.getAttribute('command');
      var targetIdForCommand = commandEl.getAttribute('commandfor');
      var targetForCommand = targetIdForCommand ? document.getElementById(targetIdForCommand) : null;
      if(targetForCommand && command === 'show-modal'){
        e.preventDefault();
        if(typeof targetForCommand.showModal === 'function'){
          try { targetForCommand.showModal(); } catch(_err) { targetForCommand.setAttribute('open', ''); }
        } else {
          targetForCommand.setAttribute('open', '');
        }
        return;
      }
      if(targetForCommand && (command === 'close' || command === 'request-close')){
        e.preventDefault();
        if(typeof targetForCommand.close === 'function') targetForCommand.close();
        else targetForCommand.removeAttribute('open');
        return;
      }
    }
    var b = e.target && e.target.closest ? e.target.closest('[command="fill-dialog"]') : null;
    if(!b) return;
    var targetId = b.getAttribute('commandfor');
    if(!targetId) return;
    var dialog = document.getElementById(targetId);
    if(!dialog) return;
    var raw = b.getAttribute('data-dialog-data');
    if(!raw) return;
    var data;
    try { data = JSON.parse(raw); } catch(_err) { return; }
    Object.keys(data).forEach(function(k){
      var inp = dialog.querySelector('[name="col_' + k + '"]');
      if(inp){
        inp.value = data[k] === null || data[k] === undefined ? '' : String(data[k]);
        inp.placeholder = data[k] === null || data[k] === undefined ? 'NULL' : '';
      }
      var hidden = dialog.querySelector('#dialog-field-' + k);
      if(hidden){
        hidden.value = data[k] === null || data[k] === undefined ? '' : String(data[k]);
      }
    });
    var rowidInp = dialog.querySelector('[name="rowid"]');
    if(rowidInp && data.rowid !== undefined) rowidInp.value = String(data.rowid);
    if(typeof dialog.showModal === 'function') dialog.showModal();
  }, true);
  (function initWorkflowPoll(){
    // Driven by <script type="application/json" id="__koze_poll"> injected by
    // the server when a route called workflowStatus(..., { poll }). Each tick, we
    // re-fetch the current URL and swap <body> contents so every { status.* } in
    // the template re-renders against fresh data. The server sets the
    // x-koze-poll-done header when the 'until' predicate reports terminal.
    function parseInterval(v){
      if(typeof v === 'number') return v > 0 ? v : 30000;
      if(!v) return 30000;
      var m = String(v).match(/^(\\d+(?:\\.\\d+)?)(ms|s|m)?$/i);
      if(!m) return 30000;
      var n = parseFloat(m[1]);
      var u = (m[2] || 's').toLowerCase();
      if(u === 'ms') return n;
      if(u === 'm') return n * 60000;
      return n * 1000;
    }
    function readConfig(){
      var el = document.getElementById('__koze_poll');
      if(!el) return null;
      try { return JSON.parse(el.textContent || '{}'); } catch(_e) { return null; }
    }
    var timer = null;
    var stopped = false;
    function stop(){ stopped = true; if(timer){ clearTimeout(timer); timer = null; } }
    function tick(interval){
      if(stopped) return;
      timer = setTimeout(function(){
        if(stopped) return;
        if(document.hidden){ tick(interval); return; }
        fetch(location.pathname + location.search, {
          headers: { 'x-koze-poll': '1' },
          credentials: 'same-origin',
        })
          .then(function(r){
            var done = r.headers.get('x-koze-poll-done') === '1';
            return r.text().then(function(html){ return { html: html, done: done, ok: r.ok }; });
          })
          .then(function(res){
            if(stopped) return;
            if(!res.ok){ tick(interval); return; }
            if(typeof DOMParser === 'undefined'){ location.reload(); return; }
            var doc = new DOMParser().parseFromString(res.html, 'text/html');
            if(doc && doc.body){
              document.body.innerHTML = doc.body.innerHTML;
              syncModalDialogs();
            }
            if(res.done){ stop(); return; }
            var next = readConfig();
            tick(next ? parseInterval(next.interval) : interval);
          })
          .catch(function(){ if(!stopped) tick(interval); });
      }, interval);
    }
    function start(){
      var cfg = readConfig();
      if(!cfg) return;
      tick(parseInterval(cfg.interval));
    }
    if(document.readyState === 'loading'){
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  })();
  function confirmClick(e){
    var el = e.target && e.target.closest ? e.target.closest('[confirm]') : null;
    if(!el) return;
    var msg = el.getAttribute('confirm');
    if(!msg) return;
    if(!window.confirm(msg)){ e.preventDefault(); e.stopPropagation(); }
  }
  document.addEventListener('click', confirmClick, true);
  document.addEventListener('submit', function(e){
    var f = e.target && e.target.matches && e.target.matches('form[confirm]') ? e.target : null;
    if(!f) return;
    var msg = f.getAttribute('confirm');
    if(!msg) return;
    if(!window.confirm(msg)){ e.preventDefault(); e.stopPropagation(); }
  }, true);
  document.addEventListener('submit', function(e){
    if(e.defaultPrevented) return;
    var f = e.target;
    if(!f || !f.querySelector) return;
    var aName = formActionName(f);
    if(!aName) return;
    var mode = actionFormMode(f);
    if(!mode) return;
    if(String(f.method || 'GET').toUpperCase() !== 'POST') return;
    if(f.target && f.target !== '_self') return;
    setActionPending(f, aName);
    var state = mode === 'state' ? updateActionState(aName, { error: undefined, pending: true, success: false }) : null;
    if(state) callActionHook(state, 'pending', { action: aName, form: f });
    e.preventDefault();
    var headers = { 'x-koze-action': mode === 'state' ? 'augment' : 'augment-html' };
    if(mode === 'state') headers.accept = 'application/json';
    fetch(f.action || location.href, {
      method: 'POST',
      body: new FormData(f),
      credentials: 'same-origin',
      headers: headers
    })
      .then(function(response){
        return mode === 'state' ? handleStateActionResponse(response, aName, f) : handleActionResponse(response);
      })
      .catch(function(err){
        console.error('[koze] form action error:', err);
        var failedState = mode === 'state' ? updateActionState(aName, { error: err && err.message ? err.message : 'Action failed', pending: false, success: false }) : null;
        if(failedState) {
          callActionHook(failedState, 'error', { action: aName, form: f, error: failedState.error });
          callActionHook(failedState, 'settled', { action: aName, form: f, error: failedState.error });
        }
      })
      .then(function(){ clearActionPending(f); }, function(){ clearActionPending(f); });
  }, true);
  document.addEventListener('change', function(e){
    var t = e.target;
    if(!t || !t.getAttribute) return;
    var gAll = t.getAttribute('data-select-all');
    if(gAll){
      by('[data-select-item]').filter(function(i){ return i.getAttribute('data-select-item') === gAll; }).forEach(function(i){ i.checked = !!t.checked; });
      syncGroup(gAll);
      return;
    }
    var gItem = t.getAttribute('data-select-item');
    if(gItem) syncGroup(gItem);
  }, true);
  by('[data-select-all]').forEach(function(m){ var g = m.getAttribute('data-select-all'); if(g) syncGroup(g); });
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', syncModalDialogs, { once: true });
  } else {
    syncModalDialogs();
  }
})();`;

export const REACTIVE_RUNTIME_VERSION = 3;

const REACTIVE_RUNTIME_SOURCE = `(function(g){
  const runtimeVersion = ${REACTIVE_RUNTIME_VERSION};
  if(g.__kozeReactive && g.__kozeReactive.__version >= runtimeVersion) return;
  const targetMap = new WeakMap();
  const proxyMap = new WeakMap();
  const getterCache = new Map();
  const setterCache = new Map();
  let active = null;
  const allEffects = new Set();
  const queue = new Set();
  let flushing = false;
  function nearestIslandRoot(node){
    let current = node && node.nodeType === 1 ? node : (node && node.parentElement) ? node.parentElement : null;
    while(current){
      if(current.hasAttribute && current.hasAttribute('data-k-island-root')) return current;
      current = current.parentElement;
    }
    return null;
  }
  function belongsToMount(node, root){
    const islandRoot = nearestIslandRoot(node);
    if(root && root.nodeType === 1 && root.hasAttribute && root.hasAttribute('data-k-island-root')){
      return islandRoot === root;
    }
    return islandRoot == null;
  }
  function matchesOwner(node, ownerId){
    const attrOwner = node && node.getAttribute ? node.getAttribute('data-k-owner') : null;
    if(ownerId) return attrOwner === ownerId;
    return attrOwner == null || attrOwner === '';
  }
  function by(sel, root, ownerId){
    return Array.prototype.slice.call((root || document).querySelectorAll(sel)).filter(function(node){
      if(ownerId) return matchesOwner(node, ownerId);
      return belongsToMount(node, root || document) && matchesOwner(node, ownerId);
    });
  }
  function rawHtml(v){ return v == null ? '' : String(v); }
  function escapeHtml(v){
    if(v == null) return '';
    return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  function sanitizeHtml(v){
    let html = rawHtml(v);
    html = html.replace(/<script\\b[^>]*>[\\s\\S]*?<\\/script>/gi, '');
    html = html.replace(/<iframe\\b[^>]*>[\\s\\S]*?<\\/iframe>/gi, '');
    html = html.replace(/<object\\b[^>]*>[\\s\\S]*?<\\/object>/gi, '');
    html = html.replace(/<embed\\b[^>]*>/gi, '');
    html = html.replace(/\\son[a-z]+\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)/gi, '');
    html = html.replace(/\\s(href|src|xlink:href)\\s*=\\s*(["'])\\s*javascript:[\\s\\S]*?\\2/gi, ' $1="#"');
    html = html.replace(/\\s(href|src|xlink:href)\\s*=\\s*javascript:[^\\s>]+/gi, ' $1="#"');
    html = html.replace(/\\ssrcdoc\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)/gi, '');
    return html;
  }
  g.__kozeRawHtml = g.__kozeRawHtml || rawHtml;
  g.__kozeEscapeHtml = g.__kozeEscapeHtml || escapeHtml;
  g.__kozeSanitizeHtml = g.__kozeSanitizeHtml || sanitizeHtml;
  function queueRun(fn){
    queue.add(fn);
    if(flushing) return;
    flushing = true;
    Promise.resolve().then(function(){
      try {
        while(queue.size){
          const jobs = Array.from(queue);
          queue.clear();
          for (const job of jobs) job();
        }
      } finally {
        flushing = false;
      }
    });
  }
  function cleanup(effect){
    const deps = effect.__deps || [];
    for (const dep of deps) dep.delete(effect);
    effect.__deps = [];
  }
  function track(target, key){
    if(!active) return;
    let depsMap = targetMap.get(target);
    if(!depsMap){ depsMap = new Map(); targetMap.set(target, depsMap); }
    let dep = depsMap.get(key);
    if(!dep){ dep = new Set(); depsMap.set(key, dep); }
    if(dep.has(active)) return;
    dep.add(active);
    if(!active.__deps) active.__deps = [];
    active.__deps.push(dep);
  }
  function trigger(target, key){
    const depsMap = targetMap.get(target);
    if(!depsMap) return;
    const effects = new Set();
    const add = function(k){
      const dep = depsMap.get(k);
      if(dep) dep.forEach(function(e){ effects.add(e); });
    };
    add(key);
    add('*');
    effects.forEach(function(e){ queueRun(e); });
  }
  function isObject(value){ return value !== null && typeof value === 'object'; }
  function proxify(value){
    if(!isObject(value)) return value;
    if(proxyMap.has(value)) return proxyMap.get(value);
    const proxy = new Proxy(value, {
      get(target, key, receiver){
        track(target, key);
        const out = Reflect.get(target, key, receiver);
        return isObject(out) ? proxify(out) : out;
      },
      set(target, key, next, receiver){
        const prev = target[key];
        const result = Reflect.set(target, key, next, receiver);
        if(prev !== next) trigger(target, key);
        if(Array.isArray(target) && key !== 'length') trigger(target, 'length');
        return result;
      },
      deleteProperty(target, key){
        const had = Object.prototype.hasOwnProperty.call(target, key);
        const result = Reflect.deleteProperty(target, key);
        if(had) trigger(target, key);
        return result;
      }
    });
    proxyMap.set(value, proxy);
    return proxy;
  }
  function effect(fn){
    const run = function(){
      cleanup(run);
      active = run;
      try { fn(); } finally { active = null; }
    };
    run.__deps = [];
    allEffects.add(run);
    run();
    return function(){ cleanup(run); allEffects.delete(run); };
  }
  function state(initial){ return proxify(initial); }
  function replace(_prev, next){ return proxify(next); }
  function scope(factory){
    try { return factory ? (factory() || {}) : {}; }
    catch(_err){ return {}; }
  }
  function compileGetter(expr){
    if(getterCache.has(expr)) return getterCache.get(expr);
    const fn = new Function('$scope', '$el', 'with($scope){ return (' + expr + '); }');
    getterCache.set(expr, fn);
    return fn;
  }
  function compileSetter(expr){
    if(setterCache.has(expr)) return setterCache.get(expr);
    const fn = new Function('$scope', '$el', '$value', 'with($scope){ ' + expr + ' = $value; return ' + expr + '; }');
    setterCache.set(expr, fn);
    return fn;
  }
  function readExpr(scopeObj, expr, el){
    return compileGetter(expr)(scopeObj || {}, el);
  }
  function writeExpr(scopeObj, expr, value, el){
    return compileSetter(expr)(scopeObj || {}, el, value);
  }
  function renderer(source){
    return new Function('$scope', source);
  }
  function applyProp(el, prop, value){
    if(prop === 'open' && el && el.tagName === 'DIALOG'){
      const shouldOpen = !!value;
      if(shouldOpen && !el.open){
        if(typeof el.showModal === 'function'){
          try { el.showModal(); return; } catch(_err) {}
        }
        el.setAttribute('open', '');
        return;
      }
      if(!shouldOpen && el.open){
        if(typeof el.close === 'function'){
          try { el.close(); return; } catch(_err) {}
        }
        el.removeAttribute('open');
        return;
      }
      return;
    }
    if(prop === 'hidden' || prop === 'disabled' || prop === 'checked' || prop === 'selected' || prop === 'open'){
      el[prop] = !!value;
      return;
    }
    if(prop in el){
      el[prop] = value == null ? '' : value;
      return;
    }
    if(value == null){
      el.removeAttribute(prop);
      return;
    }
    el.setAttribute(prop, String(value));
  }
  function applyText(el, value){
    const next = value == null ? '' : String(value);
    if(el.textContent !== next) el.textContent = next;
  }
function parseOwnedMarker(raw){
  const text = raw || '';
  if(text.indexOf('o:') !== 0) return { owner: null, id: text, marker: text };
  const sep = text.indexOf(':', 2);
  if(sep === -1) return { owner: null, id: text, marker: text };
  return { owner: text.slice(2, sep), id: text.slice(sep + 1), marker: text };
}
function markerMatchesOwner(parsed, ownerId){
  if(ownerId) return parsed.owner === ownerId;
  return parsed.owner == null;
}
function findBlockEnd(start, marker, root){
  const walker = document.createTreeWalker(root || document, NodeFilter.SHOW_COMMENT);
  walker.currentNode = start;
  let node = walker.nextNode();
  while(node){
    if((node.nodeValue || '').trim() === '/k-block:' + marker) return node;
    node = walker.nextNode();
    }
    return null;
  }
  function clearBetween(start, end){
    let node = start.nextSibling;
    while(node && node !== end){
      const next = node.nextSibling;
      node.parentNode && node.parentNode.removeChild(node);
      node = next;
    }
  }
  function parseBlockStart(value){
    const text = (value || '').trim();
    const rest = text.slice('k-block:'.length);
    const owned = parseOwnedMarker(rest);
    const sep = owned.id.indexOf(':');
    if(sep === -1) return { owner: owned.owner, id: owned.id, marker: owned.marker, context: {} };
    const id = owned.id.slice(0, sep);
    const raw = owned.id.slice(sep + 1);
    const marker = owned.owner ? 'o:' + owned.owner + ':' + id : id;
    try { return { owner: owned.owner, id: id, marker: marker, context: JSON.parse(decodeURIComponent(raw)) || {} }; }
    catch(_err){ return { owner: owned.owner, id: id, marker: marker, context: {} }; }
  }
  function parseLocalScope(value){
    if(!value) return {};
    try { return JSON.parse(decodeURIComponent(value)) || {}; }
    catch(_err){ return {}; }
  }
  function activateScripts(node){
    if(!node) return;
    const scripts = [];
    if(node.nodeType === 1 && node.tagName === 'SCRIPT') scripts.push(node);
    if(node.querySelectorAll){
      Array.prototype.forEach.call(node.querySelectorAll('script'), function(script){ scripts.push(script); });
    }
    scripts.forEach(function(script){
      if(!script || !script.parentNode) return;
      const replacement = document.createElement('script');
      Array.prototype.forEach.call(script.attributes || [], function(attr){
        replacement.setAttribute(attr.name, attr.value);
      });
      replacement.textContent = script.textContent || '';
      script.parentNode.replaceChild(replacement, script);
    });
  }
  function scopeForElement(scopeObj, el){
    if(!el || !el.getAttribute) return scopeObj || {};
    const scoped = Object.create(scopeObj || {});
    const nodes = [];
    let node = el;
    while(node && node.getAttribute){
      if(node.hasAttribute('data-k-scope')) nodes.unshift(node);
      node = node.parentElement;
    }
    nodes.forEach(function(scopeNode){
      const locals = parseLocalScope(scopeNode.getAttribute('data-k-scope'));
      Object.keys(locals).forEach(function(key){ scoped[key] = locals[key]; });
    });
    return scoped;
  }
function renderBlock(start, end, scopeObj, renderer, context){
    const scopeWithAnchor = Object.create(scopeObj || {});
    Object.keys(context || {}).forEach(function(key){ scopeWithAnchor[key] = context[key]; });
    scopeWithAnchor.$anchor = start.parentElement || start.parentNode || null;
    scopeWithAnchor.$block = context || {};
    const html = renderer(scopeWithAnchor);
    const tpl = document.createElement('template');
    tpl.innerHTML = html == null ? '' : String(html);
    const insertedNodes = Array.prototype.slice.call(tpl.content.childNodes || []);
  clearBetween(start, end);
  end.parentNode && end.parentNode.insertBefore(tpl.content, end);
  insertedNodes.forEach(function(node){ activateScripts(node); });
}
function findHtmlEnd(start, marker, root){
  const walker = document.createTreeWalker(root || document, NodeFilter.SHOW_COMMENT);
  walker.currentNode = start;
  let node = walker.nextNode();
  while(node){
    if((node.nodeValue || '').trim() === '/k-html:' + marker) return node;
    node = walker.nextNode();
  }
  return null;
}
function renderHtml(start, end, scopeObj, expr){
  const html = sanitizeHtml(readExpr(scopeObj || {}, expr, start.parentElement || start.parentNode || null));
  const tpl = document.createElement('template');
  tpl.innerHTML = html == null ? '' : String(html);
  const insertedNodes = Array.prototype.slice.call(tpl.content.childNodes || []);
  clearBetween(start, end);
  end.parentNode && end.parentNode.insertBefore(tpl.content, end);
  insertedNodes.forEach(function(node){ activateScripts(node); });
}
function initHtml(scopeObj, init, root, ownerId){
  const walker = document.createTreeWalker(root || document, NodeFilter.SHOW_COMMENT);
  const starts = [];
  let node = walker.nextNode();
  while(node){
    const value = (node.nodeValue || '').trim();
    if(value.indexOf('k-html:') === 0 && (ownerId || belongsToMount(node, root || document))) starts.push(node);
    node = walker.nextNode();
  }
  starts.forEach(function(start){
    if(start.__kozeHtmlInit) return;
    const parsed = parseOwnedMarker((start.nodeValue || '').trim().slice('k-html:'.length));
    if(!markerMatchesOwner(parsed, ownerId)) return;
    const end = findHtmlEnd(start, parsed.marker, root);
    if(!end) return;
    let expr = '';
    try { expr = decodeURIComponent(parsed.id); } catch(_err){ expr = parsed.id; }
    start.__kozeHtmlInit = true;
    effect(function(){
      renderHtml(start, end, scopeObj, expr);
      init();
    });
  });
}
function readEventExpr(scopeObj, expr, el, event){
  const trimmed = String(expr || '').trim();
  if(trimmed && trimmed.indexOf('$event') === -1 && trimmed.indexOf('$el') === -1){
    const callMatch = trimmed.match(/^([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)\\(([\\s\\S]*)\\)$/);
    if(callMatch){
      const calleeExpr = callMatch[1];
      const argsExpr = (callMatch[2] || '').trim();
      const argList = argsExpr ? '[' + argsExpr + ']' : '[]';
      const fn = new Function('$scope', '$el', '$event', 'with($scope){ return (' + calleeExpr + ')(...' + argList + ', $event, $el); }');
      return fn(scopeObj || {}, el, event);
    }
    const refMatch = trimmed.match(/^([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)$/);
    if(refMatch){
      const fn = new Function('$scope', '$el', '$event', 'with($scope){ return (' + trimmed + ')($event, $el); }');
      return fn(scopeObj || {}, el, event);
    }
  }
  const fn = new Function('$scope', '$el', '$event', 'with($scope){ return (' + trimmed + '); }');
  return fn(scopeObj || {}, el, event);
}
function initBlocks(scopeObj, blockRenderers, init, root, ownerId){
  if(!blockRenderers) return;
  const walker = document.createTreeWalker(root || document, NodeFilter.SHOW_COMMENT);
  const starts = [];
  let node = walker.nextNode();
  while(node){
    const value = (node.nodeValue || '').trim();
    if(value.indexOf('k-block:') === 0 && (ownerId || belongsToMount(node, root || document))) starts.push(node);
      node = walker.nextNode();
    }
    starts.forEach(function(start){
      if(start.__kozeBlockInit) return;
      const parsed = parseBlockStart(start.nodeValue || '');
      if(!markerMatchesOwner(parsed, ownerId)) return;
      const renderer = blockRenderers[parsed.id];
      if(typeof renderer !== 'function') return;
      const end = findBlockEnd(start, parsed.marker, root);
      if(!end) return;
      start.__kozeBlockInit = true;
      effect(function(){
        renderBlock(start, end, scopeObj, renderer, parsed.context);
        init();
      });
    });
  }
  function mount(scopeObj, blockRenderers, root, ownerId){
    const mountRoot = root || document;
    const debug = g.__kozeReactiveDebug = g.__kozeReactiveDebug || { mounts: [] };
    const mountRecord = {
      ownerId: ownerId || null,
      readyState: document.readyState,
      initRuns: 0,
      textCandidates: 0,
      eventCandidates: 0,
      completed: false,
      errors: []
    };
    debug.mounts.push(mountRecord);
    if(debug.mounts.length > 12) debug.mounts.shift();
    function noteError(phase, err){
      const message = phase + ': ' + (err && err.message ? err.message : String(err));
      mountRecord.errors.push(message);
      if(mountRecord.errors.length > 8) mountRecord.errors.shift();
      console.error('[koze] reactive mount error:', message, err);
    }
    function init(){
      mountRecord.initRuns += 1;
      mountRecord.readyState = document.readyState;
      try {
      initHtml(scopeObj, init, mountRoot, ownerId);
      initBlocks(scopeObj, blockRenderers, init, mountRoot, ownerId);
      const textNodes = by('[data-k-text]', mountRoot, ownerId);
      mountRecord.textCandidates = textNodes.length;
      textNodes.forEach(function(el){
        if(el.__kozeTextInit) return;
        el.__kozeTextInit = true;
        const expr = el.getAttribute('data-k-text') || '';
        effect(function(){
          applyText(el, readExpr(scopeForElement(scopeObj, el), expr, el));
        });
      });
      by('[data-k-bind-value]', mountRoot, ownerId).forEach(function(el){
        if(el.__kozeBindValueInit) return;
        el.__kozeBindValueInit = true;
        const expr = el.getAttribute('data-k-bind-value') || '';
        effect(function(){
          const next = readExpr(scopeForElement(scopeObj, el), expr, el);
          const normalized = next == null ? '' : String(next);
          if(el.value !== normalized) el.value = normalized;
        });
        const eventName = el.tagName === 'SELECT' ? 'change' : 'input';
        el.addEventListener(eventName, function(){
          writeExpr(scopeForElement(scopeObj, el), expr, el.value, el);
        });
      });
      by('[data-k-bind-checked]', mountRoot, ownerId).forEach(function(el){
        if(el.__kozeBindCheckedInit) return;
        el.__kozeBindCheckedInit = true;
        const expr = el.getAttribute('data-k-bind-checked') || '';
        effect(function(){
          const next = !!readExpr(scopeForElement(scopeObj, el), expr, el);
          if(el.checked !== next) el.checked = next;
        });
        el.addEventListener('change', function(){
          writeExpr(scopeForElement(scopeObj, el), expr, !!el.checked, el);
        });
      });
      by('[data-k-bind-this]', mountRoot, ownerId).forEach(function(el){
        if(el.__kozeBindThisInit) return;
        el.__kozeBindThisInit = true;
        const expr = el.getAttribute('data-k-bind-this') || '';
        if(!expr || expr === '$el') return;
        try { writeExpr(scopeForElement(scopeObj, el), expr, el, el); } catch(_err) {}
      });
      by('[data-k-bind-prop]', mountRoot, ownerId).forEach(function(el){
        if(el.__kozeBindPropInit) return;
        el.__kozeBindPropInit = true;
        const prop = el.getAttribute('data-k-bind-prop') || '';
        const expr = el.getAttribute('data-k-bind-expr') || '';
        if(!prop || !expr) return;
        effect(function(){
          applyProp(el, prop, readExpr(scopeForElement(scopeObj, el), expr, el));
        });
        const writeCurrent = function(){
          try {
            const value = prop in el ? el[prop] : el.getAttribute(prop);
            writeExpr(scopeForElement(scopeObj, el), expr, value, el);
          } catch(_err) {}
        };
        if(prop === 'open' && el.tagName === 'DIALOG'){
          el.addEventListener('close', writeCurrent);
          el.addEventListener('cancel', function(){ setTimeout(writeCurrent, 0); });
          el.addEventListener('toggle', writeCurrent);
          if(typeof MutationObserver !== 'undefined'){
            const observer = new MutationObserver(writeCurrent);
            observer.observe(el, { attributes: true, attributeFilter: ['open'] });
          }
        } else {
          el.addEventListener('change', writeCurrent);
          el.addEventListener('input', writeCurrent);
        }
      });
      by('*', mountRoot, ownerId).forEach(function(el){
        if(el.__kozeAttrPropsInit) return;
        const attrs = Array.prototype.slice.call(el.attributes || []).filter(function(attr){
          return attr && attr.name && attr.name.indexOf('data-k-attr-') === 0;
        });
        if(!attrs.length) return;
        el.__kozeAttrPropsInit = true;
        attrs.forEach(function(attr){
          const prop = attr.name.slice('data-k-attr-'.length);
          const expr = attr.value || '';
          effect(function(){
            applyProp(el, prop, readExpr(scopeForElement(scopeObj, el), expr, el));
          });
        });
      });
      const eventNodes = by('*', mountRoot, ownerId);
      mountRecord.eventCandidates = eventNodes.filter(function(el){
        return Array.prototype.slice.call(el.attributes || []).some(function(attr){
          return attr && attr.name && attr.name.indexOf('data-k-on-') === 0;
        });
      }).length;
      eventNodes.forEach(function(el){
        if(el.__kozeEventInit) return;
        const attrs = Array.prototype.slice.call(el.attributes || []).filter(function(attr){
          return attr && attr.name && attr.name.indexOf('data-k-on-') === 0;
        });
        if(!attrs.length) return;
        el.__kozeEventInit = true;
        attrs.forEach(function(attr){
          const eventName = attr.name.slice('data-k-on-'.length);
          const expr = attr.value || '';
          el.addEventListener(eventName, function(event){
            try {
              readEventExpr(scopeForElement(scopeObj, el), expr, el, event);
            } catch(err) {
              console.error('[koze] local event error:', err);
            }
          });
        });
      });
      mountRecord.completed = true;
      } catch(err) {
        noteError('init', err);
      }
    }
    init();
    if(document.readyState === 'loading'){
      document.addEventListener('DOMContentLoaded', init, { once: true });
    }
    Promise.resolve().then(init);
    setTimeout(init, 0);
  }
  g.__kozeReactive = { __version: runtimeVersion, state, effect, replace, scope, mount, renderer };
  g.addEventListener && g.addEventListener('koze:invalidate-reads', function(){
    allEffects.forEach(function(e){ queueRun(e); });
  });
})(window);`;

export function buildReactiveRuntimeScriptTag(isDev: boolean): string {
  return `<script>${isDev ? REACTIVE_RUNTIME_SOURCE : compactInlineJs(REACTIVE_RUNTIME_SOURCE)}</script>`;
}

export function buildBridgeScriptSource(isDev: boolean): string {
  return isDev ? BRIDGE_SOURCE : compactInlineJs(BRIDGE_SOURCE);
}

export function buildBridgeScriptTag(isDev: boolean): string {
  return `<script>${buildBridgeScriptSource(isDev)}</script>`;
}

export function prepareRootLayoutSource(opts: {
  source: string;
  isDev: boolean;
  themeCss: string | null;
  uiConfigValues: UiConfigValues | null;
}): string {
  let source = opts.source;
  const headInjections: string[] = [];
  const bodyInjections: string[] = [];

  if (opts.uiConfigValues) {
    source = patchHtmlTag(source, opts.uiConfigValues.theme, opts.uiConfigValues.radius);
  }

  if (opts.uiConfigValues) {
    const themeInitScript = `<script>(function(){try{var d=document.documentElement;var s=localStorage.getItem('kui-theme');var fallback=d.getAttribute('data-theme')==='system'?'system':(d.classList.contains('dark')?'dark':'light');var p=(s==='light'||s==='dark'||s==='system')?s:fallback;d.classList.remove('dark');d.removeAttribute('data-theme');if(p==='dark'){d.classList.add('dark');}else if(p==='system'){d.setAttribute('data-theme','system');}}catch(e){}})()</script>`;
    headInjections.push(themeInitScript);
  }

  if (opts.themeCss) {
    headInjections.push(`<style>${opts.themeCss}</style>`);
  }

  headInjections.push(`<style>@view-transition { navigation: auto; }</style>`);

  const actionScript = buildBridgeScriptTag(opts.isDev);
  const reactiveRuntimeScript = buildReactiveRuntimeScriptTag(opts.isDev);
  headInjections.push(reactiveRuntimeScript);
  bodyInjections.push(actionScript);

  source = insertBeforeClosingTag(source, 'head', ROOT_HEAD_SLOT);
  source = insertBeforeClosingTag(source, 'body', ROOT_BODY_SLOT);
  source = source.replace(ROOT_HEAD_SLOT, headInjections.join('\n'));
  source = source.replace(ROOT_BODY_SLOT, bodyInjections.join('\n'));

  return source;
}
