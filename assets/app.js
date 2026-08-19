/* airss — a Reeder-style reader for the feeds in this repo. */
(() => {
'use strict';

/* Filled from feeds.json, which scripts/build_feeds.py regenerates on every
   deploy — new XML files in the repo root appear here automatically. */
let FEEDS = [];

const CONTENT_NS = 'http://purl.org/rss/1.0/modules/content/';
const LS = { read: 'airss.read', star: 'airss.star', theme: 'airss.theme', sel: 'airss.sel', pos: 'airss.pos' };

const $ = id => document.getElementById(id);

const state = {
  items: [],
  byKey: new Map(),
  view: 'all',
  selected: null,
  q: '',
  read: loadSet(LS.read),
  star: loadSet(LS.star),
  status: {},
  nextUrls: new Map(),
  loadedFeeds: new Set(),
};

let pendingKey = null;

/* ---------- storage helpers ---------- */

function loadSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key)) || []); }
  catch { return new Set(); }
}
function saveSet(key, set, cap = 5000) {
  let arr = [...set];
  if (arr.length > cap) arr = arr.slice(arr.length - cap);
  try { localStorage.setItem(key, JSON.stringify(arr)); } catch {}
}
function loadJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function saveJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

/* ---------- tiny utils ---------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function relTime(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 7 * 86400) return Math.floor(s / 86400) + 'd';
  const d = new Date(ts);
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return new Intl.DateTimeFormat(undefined, opts).format(d);
}

function fmtDate(ts) {
  if (!ts) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeStyle: 'short' }).format(new Date(ts));
}

/* ---------- markdown-ish → HTML (ByteDance feed) ---------- */

const BLOCK_TAG = /^<(p|div|ul|ol|table|blockquote|h[1-6]|figure|pre|video|img|hr|br|section)\b/i;

function mdInline(s) {
  return s.split(/(<[^>]*>)/).map(part => {
    if (part.startsWith('<')) return part;
    return part
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/https?:\/\/[^\s<>"'（）【】。，；！？]+/g, m => {
        const url = m.replace(/[.,;:!?]+$/, '');
        const rest = m.slice(url.length);
        return `<a href="${url}">${url}</a>${rest}`;
      });
  }).join('');
}

function mdToHtml(src) {
  const out = [];
  for (let block of src.split(/\n\s*\n/)) {
    block = block.trim();
    if (!block) continue;

    if (block.startsWith('>')) {
      const inner = block.split('\n')
        .map(l => l.trim().replace(/^>\s?/, '').trim())
        .filter(Boolean)
        .join(' ');
      if (inner) out.push(`<blockquote><p>${mdInline(inner)}</p></blockquote>`);
      continue;
    }

    const h = block.match(/^(#{1,6})\s+([^\n]+)(?:\n([\s\S]*))?$/);
    if (h) {
      const lvl = Math.min(h[1].length + 1, 4);
      out.push(`<h${lvl}>${mdInline(h[2].trim())}</h${lvl}>`);
      if (h[3] && h[3].trim()) out.push(`<p>${mdInline(h[3].trim().replace(/\n+/g, ' '))}</p>`);
      continue;
    }

    if (BLOCK_TAG.test(block)) { out.push(block); continue; }
    out.push(`<p>${mdInline(block.replace(/\n+/g, ' '))}</p>`);
  }
  return out.join('\n');
}

/* ---------- sanitizer ---------- */

function sanitize(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;

  tpl.content.querySelectorAll('script,style,link,meta,iframe,object,embed,form,noscript').forEach(n => n.remove());

  tpl.content.querySelectorAll('*').forEach(el => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      else if ((name === 'href' || name === 'src' || name === 'srcset') &&
               /^\s*(javascript|vbscript|data:text\/html)/i.test(attr.value)) el.removeAttribute(attr.name);
      else if (name === 'style' && /position\s*:\s*(fixed|sticky)/i.test(attr.value)) el.removeAttribute(attr.name);
    }
    switch (el.tagName) {
      case 'IMG':
        el.setAttribute('loading', 'lazy');
        el.setAttribute('decoding', 'async');
        // WeChat's CDN answers any request carrying a Referer with a 140x140
        // 未经允许不可引用 placeholder; with no Referer it serves the real image
        el.setAttribute('referrerpolicy', 'no-referrer');
        break;
      case 'A':
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
        break;
      case 'VIDEO':
        el.setAttribute('controls', '');
        el.setAttribute('preload', 'none');
        el.setAttribute('playsinline', '');
        el.removeAttribute('autoplay');
        break;
    }
  });

  tpl.content.querySelectorAll('table').forEach(table => {
    const wrap = document.createElement('div');
    wrap.className = 'tbl-wrap';
    table.replaceWith(wrap);
    wrap.append(table);
  });

  return tpl;
}

/* ---------- feed loading ---------- */

const JUNK_TITLE = /^no ?title$/i;

async function parseFeed(feed, xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('XML parse error');

  let nextUrl = null;
  const atomLinks = doc.getElementsByTagNameNS('http://www.w3.org/2005/Atom', 'link');
  for (const el of atomLinks) {
    if (el.getAttribute('rel') === 'next') nextUrl = el.getAttribute('href');
  }
  if (!nextUrl) {
    const links = doc.getElementsByTagName('link');
    for (const el of links) {
      if (el.getAttribute('rel') === 'next') nextUrl = el.getAttribute('href');
    }
  }

  const rawItems = [...doc.getElementsByTagName('item')];
  const items = [];

  for (let i = 0; i < rawItems.length; i++) {
    const el = rawItems[i];
    const text = tag => el.getElementsByTagName(tag)[0]?.textContent?.trim() ?? '';
    const link = text('link');
    const encoded = el.getElementsByTagNameNS(CONTENT_NS, 'encoded')[0]?.textContent;
    const raw = encoded || el.getElementsByTagName('description')[0]?.textContent || '';
    const ts = +new Date(text('pubDate')) || 0;
    // <crawled> is when the scraper fetched the article; older feed builds
    // (or feeds without it) fall back to the published date.
    const crawledTs = +new Date(text('crawled')) || ts;
    const tpl = sanitize(feed.format === 'md' ? mdToHtml(raw) : raw);
    const rawTitle = text('title');
    const title = (JUNK_TITLE.test(rawTitle) ? '' : rawTitle) || '(untitled)';

    // Headline-only feeds repeat the title as the body; no point previewing it
    let preview = makePreview(tpl);
    const norm = s => s.replace(/\s+/g, ' ').trim().toLowerCase();
    if (norm(preview) === norm(title)) preview = '';

    items.push({
      key: feed.id + '|' + (link || i),
      feed, link, ts, crawledTs, title, preview,
      html: tpl.innerHTML,
    });

    // Time slice every 20 items to avoid freezing the UI
    if (i % 20 === 19) await new Promise(r => setTimeout(r, 0));
  }
  
  return { items: dedupeByLink(items), nextUrl };
}

/* First paragraph with real prose — skips leading link-badge clusters. */
function makePreview(tpl) {
  for (const block of tpl.content.querySelectorAll('p, blockquote')) {
    const t = block.textContent.replace(/\s+/g, ' ').trim();
    if (t.length > 60) return t.slice(0, 200);
  }
  return tpl.content.textContent.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/* Crawler re-runs leave duplicate entries (same link, sometimes titled "No title");
   keep the richest variant of each link. */
function dedupeByLink(items) {
  const seen = new Map();
  for (const it of items) {
    const id = it.link || it.key;
    const prev = seen.get(id);
    seen.set(id, prev ? pickRicher(prev, it) : it);
  }
  return [...seen.values()];
}

function pickRicher(a, b) {
  const aJunk = a.title === '(untitled)';
  const bJunk = b.title === '(untitled)';
  if (aJunk !== bJunk) return aJunk ? b : a;
  if (a.ts !== b.ts) return b.ts > a.ts ? b : a;
  return b.html.length > a.html.length ? b : a;
}

async function loadFeed(feed, url = null) {
  const fetchUrl = url || feed.file;
  state.status[feed.id] = 'loading';
  updateNavStatus(feed.id);
  
  if (!url) state.loadedFeeds.add(feed.id);

  try {
    const res = await fetch(fetchUrl);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const xml = await res.text();
    
    // Yield before parsing
    await new Promise(r => setTimeout(r, 0));
    
    const { items, nextUrl } = await parseFeed(feed, xml);
    
    for (const it of items) {
      if (!state.byKey.has(it.key)) {
        state.byKey.set(it.key, it);
        state.items.push(it);
      }
    }
    state.items.sort((a, b) => b.ts - a.ts);
    
    if (nextUrl) {
      state.nextUrls.set(feed.id, nextUrl);
    } else {
      state.nextUrls.delete(feed.id);
    }
    state.status[feed.id] = 'ok';
  } catch (err) {
    console.error('airss: failed to load', fetchUrl, err);
    state.status[feed.id] = 'error';
  }
  
  updateNavStatus(feed.id);
  renderTimeline();
  maybeRestore();
}

async function syncAll() {
  const btn = $('sync-btn');
  if (btn.classList.contains('syncing')) return;
  btn.classList.add('syncing');
  
  const promises = FEEDS.map(feed => loadFeed(feed));
  await Promise.allSettled(promises);
  
  btn.classList.remove('syncing');
}

function maybeRestore() {
  if (pendingKey && state.byKey.has(pendingKey)) {
    const key = pendingKey;
    pendingKey = null;
    select(key, { restore: true });
  }
}

/* ---------- sidebar ---------- */

const ICON_HOME = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 10.6 12 4.2l7.5 6.4M6.2 9.5V19a1 1 0 0 0 1 1h9.6a1 1 0 0 0 1-1V9.5"/></svg>';
const ICON_TODAY = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5.5" width="16" height="14.5" rx="3"/><path d="M8 3.5v3.5M16 3.5v3.5M4 10.5h16"/></svg>';
const ICON_STAR = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.4 2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.6l5.9-.8Z"/></svg>';

function faviconHTML(feed) {
  let origin = '';
  try { origin = new URL(feed.home).origin; } catch {}
  return `<span class="favicon" style="--fc:${feed.color}">${esc((feed.title || '?')[0].toUpperCase())}` +
         (origin ? `<img src="${origin}/favicon.ico" alt="" loading="lazy">` : '') + `</span>`;
}

function buildNav() {
  const parts = [
    navBtn('all', 'Home', ICON_HOME),
    navBtn('today', 'Today', ICON_TODAY),
    navBtn('star', 'Starred', ICON_STAR),
    '<div class="nav-label">Feeds</div>',
    ...FEEDS.map(f => navBtn(f.id, f.title, faviconHTML(f), true)),
  ];
  $('nav').innerHTML = parts.join('');
}

function navBtn(view, label, iconHTML, withStatus = false) {
  return `<button class="nav-item${state.view === view ? ' active' : ''}" data-view="${esc(view)}">` +
         `${iconHTML}<span class="label">${esc(label)}</span>` +
         `${withStatus ? `<span class="nav-status" data-status="${esc(view)}"></span>` : ''}</button>`;
}

function updateNavStatus(feedId) {
  const el = document.querySelector(`.nav-status[data-status="${CSS.escape(feedId)}"]`);
  if (!el) return;
  const s = state.status[feedId];
  el.className = 'nav-status' + (s === 'loading' ? ' loading' : s === 'error' ? ' error' : '');
  el.title = s === 'error' ? 'Failed to load feed' : '';
}

/* The search placeholder doubles as the view title: it names the scope. */
function searchPlaceholder(view) {
  if (view === 'all') return 'Search all articles';
  if (view === 'today') return 'Search today';
  if (view === 'star') return 'Search starred';
  return 'Search ' + (FEEDS.find(f => f.id === view)?.title ?? view);
}

function setView(view) {
  state.view = view;
  state.q = '';
  $('search').value = '';
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $('search').placeholder = searchPlaceholder(view);
  
  if (view !== 'all' && view !== 'today' && view !== 'star') {
    if (!state.loadedFeeds.has(view)) {
      const feed = FEEDS.find(f => f.id === view);
      if (feed) loadFeed(feed);
    }
  }
  
  renderTimeline();
  $('timeline').scrollTop = 0;
  saveJSON(LS.sel, { view, key: state.selected });
  document.body.classList.remove('sidebar-open');
}

/* ---------- timeline ---------- */

function visibleItems() {
  let arr = state.items;
  if (state.view === 'star') arr = arr.filter(it => state.star.has(it.key));
  else if (state.view === 'today') {
    const t0 = new Date().setHours(0, 0, 0, 0);
    arr = arr.filter(it => it.crawledTs >= t0);
  }
  else if (state.view !== 'all') arr = arr.filter(it => it.feed.id === state.view);
  if (state.q) {
    const q = state.q.toLowerCase();
    arr = arr.filter(it => it.title.toLowerCase().includes(q) || it.preview.toLowerCase().includes(q));
  }
  return arr;
}

const STAR_PATH = '<path d="m12 3.4 2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.6l5.9-.8Z"/>';

function cardHTML(it) {
  const read = state.read.has(it.key);
  const sel = state.selected === it.key;
  const starred = state.star.has(it.key);
  const body = it.preview
    ? `<div class="card-body">
        <p class="card-preview" lang="${it.feed.lang}">${esc(it.preview.slice(0, 160))}</p>
      </div>` : '';
  return `<article class="card${read ? ' read' : ''}${sel ? ' selected' : ''}" data-key="${esc(it.key)}" role="listitem" tabindex="0">
    <button class="card-star-btn${starred ? ' starred' : ''}" title="Star (s)" aria-label="Star article" aria-pressed="${starred}">
      <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${STAR_PATH}</svg>
    </button>
    <h3 class="card-title" lang="${it.feed.lang}">${esc(it.title)}</h3>
    ${body}
    ${it.ts ? `<span class="card-time" title="${esc(fmtDate(it.ts))}">${relTime(it.ts)}</span>` : ''}
  </article>`;
}

function renderSkeletons() {
  $('cards').innerHTML = Array.from({ length: 7 }, () =>
    '<div class="card skeleton">' +
    '<div class="sk sk-title"></div><div class="sk sk-line"></div><div class="sk sk-meta"></div>' +
    '</div>').join('');
}

function renderTimeline() {
  const started = state.loadedFeeds.size > 0;
  if (!started) return; // keep skeletons until the first feed settles

  const items = visibleItems();
  if (!items.length) {
    const loading = FEEDS.some(f => state.status[f.id] === 'loading');
    const note = loading ? 'Loading…' :
      state.q ? 'No matching articles' :
      state.view === 'star' ? 'Nothing starred yet' :
      state.view === 'today' ? 'Nothing crawled today yet' : 'No articles';
    $('cards').innerHTML = `<div class="timeline-note">${note}</div>`;
    return;
  }
  
  let html = items.map(cardHTML).join('');
  
  if (state.view !== 'all' && state.view !== 'today' && state.view !== 'star' && !state.q) {
    const nextUrl = state.nextUrls.get(state.view);
    if (nextUrl) {
      const isLoading = state.status[state.view] === 'loading';
      html += `<button class="load-more-btn" data-feed="${state.view}" ${isLoading ? 'disabled' : ''}>${isLoading ? 'Loading...' : 'Load Older Articles'}</button>`;
    }
  }

  $('cards').innerHTML = html;
}

/* ---------- reader ---------- */

function select(key, opts = {}) {
  const it = state.byKey.get(key);
  if (!it) return;

  state.selected = key;
  if (!state.read.has(key)) {
    state.read.add(key);
    saveSet(LS.read, state.read);
  }
  document.querySelectorAll('.card').forEach(card => {
    const isSel = card.dataset.key === key;
    card.classList.toggle('selected', isSel);
    if (isSel) card.classList.add('read');
  });

  renderReader(it, opts);
  saveJSON(LS.sel, { view: state.view, key });
  if (!opts.restore) document.body.classList.add('reader-open');
}

function renderReader(it, opts = {}) {
  $('reader-empty').hidden = true;
  const art = $('article');
  art.hidden = false;
  art.innerHTML = `
    <header class="article-head">
      <h1 class="article-title" lang="${it.feed.lang}">${esc(it.title)}</h1>
      <div class="article-meta">
        ${it.ts ? `<span>${esc(fmtDate(it.ts))}</span>` : ''}
        ${it.link ? `<a href="${esc(it.link)}" target="_blank" rel="noopener noreferrer">Open original ↗</a>` : ''}
      </div>
    </header>
    <div class="article-body" lang="${it.feed.lang}">${it.html}</div>`;

  const pos = loadJSON(LS.pos);
  $('reader-scroll').scrollTop = (opts.restore && pos && pos.key === it.key) ? pos.top : 0;
}

function toggleStar(key) {
  if (state.star.has(key)) state.star.delete(key);
  else state.star.add(key);
  saveSet(LS.star, state.star);
  renderTimeline();
}

function openOriginal() {
  const it = state.byKey.get(state.selected);
  if (it?.link) window.open(it.link, '_blank', 'noopener');
}

function move(delta) {
  const items = visibleItems();
  if (!items.length) return;
  let idx = items.findIndex(it => it.key === state.selected);
  idx = idx === -1
    ? (delta > 0 ? 0 : items.length - 1)
    : Math.min(items.length - 1, Math.max(0, idx + delta));
  select(items[idx].key, { restore: window.innerWidth <= 760 });
  document.querySelector(`.card[data-key="${CSS.escape(items[idx].key)}"]`)
    ?.scrollIntoView({ block: 'nearest' });
}

/* ---------- events ---------- */

function bindUI() {
  $('cards').addEventListener('click', e => {
    const moreBtn = e.target.closest('.load-more-btn');
    if (moreBtn && !moreBtn.disabled) {
      const feedId = moreBtn.dataset.feed;
      const feed = FEEDS.find(f => f.id === feedId);
      const url = state.nextUrls.get(feedId);
      if (feed && url) loadFeed(feed, url);
      return;
    }
    
    const starBtn = e.target.closest('.card-star-btn');
    if (starBtn) {
      toggleStar(starBtn.closest('.card').dataset.key);
      return;
    }
    const card = e.target.closest('.card');
    if (card && !card.classList.contains('skeleton')) select(card.dataset.key);
  });

  // drop images that never loaded: favicons fall back to their monogram, and
  // article images (WeChat leaves 404ing decorative gifs behind) would otherwise
  // sit there as a broken-image icon. Capture phase -- error does not bubble.
  document.addEventListener('error', e => {
    const t = e.target;
    if (t.tagName !== 'IMG') return;
    if (t.closest('.favicon') || t.closest('.article-body')) t.remove();
  }, true);
  // reveal favicon images only once they have pixels (monogram shows until then)
  document.addEventListener('load', e => {
    if (e.target.tagName === 'IMG' && e.target.closest('.favicon')) e.target.classList.add('ok');
  }, true);

  $('nav').addEventListener('click', e => {
    const btn = e.target.closest('.nav-item');
    if (btn) setView(btn.dataset.view);
  });

  $('search').addEventListener('input', e => {
    state.q = e.target.value.trim();
    renderTimeline();
  });

  $('back-btn').addEventListener('click', () => document.body.classList.remove('reader-open'));
  $('menu-btn').addEventListener('click', () => document.body.classList.add('sidebar-open'));
  $('scrim').addEventListener('click', () => document.body.classList.remove('sidebar-open'));

  $('theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(LS.theme, next); } catch {}
  });
  
  const syncBtn = $('sync-btn');
  if (syncBtn) {
    syncBtn.addEventListener('click', () => syncAll());
  }

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
    let stored = null;
    try { stored = localStorage.getItem(LS.theme); } catch {}
    if (!stored) document.documentElement.dataset.theme = e.matches ? 'dark' : 'light';
  });

  let posTimer;
  $('reader-scroll').addEventListener('scroll', () => {
    if (!state.selected) return;
    clearTimeout(posTimer);
    posTimer = setTimeout(() =>
      saveJSON(LS.pos, { key: state.selected, top: $('reader-scroll').scrollTop }), 250);
  }, { passive: true });

  document.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    switch (e.key) {
      case 'j': case 'ArrowDown': e.preventDefault(); move(1); break;
      case 'k': case 'ArrowUp': e.preventDefault(); move(-1); break;
      case 'Enter': {
        const card = e.target.closest?.('.card');
        if (card) select(card.dataset.key);
        else openOriginal();
        break;
      }
      case 'o': openOriginal(); break;
      case 's': if (state.selected) toggleStar(state.selected); break;
      case '/': e.preventDefault(); $('search').focus(); break;
      case 'Escape':
        if (document.body.classList.contains('sidebar-open')) document.body.classList.remove('sidebar-open');
        else document.body.classList.remove('reader-open');
        break;
    }
  });
}

/* ---------- boot ---------- */

async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => console.error('airss: sw error', err));
  }

  renderSkeletons();
  bindUI();

  try {
    const res = await fetch('feeds.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    FEEDS = (await res.json()).feeds || [];
    if (!FEEDS.length) throw new Error('empty manifest');
  } catch (err) {
    console.error('airss: failed to load feeds.json', err);
    $('cards').innerHTML =
      '<div class="timeline-note">Could not load the feed manifest (feeds.json).</div>';
    return;
  }

  const saved = loadJSON(LS.sel);
  if (saved?.view && (['all', 'today', 'star'].includes(saved.view) || FEEDS.some(f => f.id === saved.view))) {
    state.view = saved.view;
  }
  pendingKey = saved?.key || null;

  buildNav();
  $('search').placeholder = searchPlaceholder(state.view);
  
  if (state.view === 'all' || state.view === 'today' || state.view === 'star') {
    const defaultFeed = FEEDS.find(f => f.id === 'crawl-log') || FEEDS[0];
    if (defaultFeed) loadFeed(defaultFeed);
  } else {
    const feed = FEEDS.find(f => f.id === state.view);
    if (feed) loadFeed(feed);
  }
}

boot();

})();
