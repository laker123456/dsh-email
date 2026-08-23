import { readFile } from 'node:fs/promises'
import { clampInt } from './config.js'
import { EmailPool, MailError, messageOf } from './mail-client.js'
import { parseHtmlMessage, truncateText } from './parse.js'
import { isLoopbackRequest } from './web.js'

export const INBOX_ROUTE = '/_dsh/dsh-email/inbox'

const MAX_INLINE_IMAGE_BYTES = 512 * 1024
const TEXT_FALLBACK_CHARS = 200000

class InboxUsageError extends Error {}

function responseJson(res: any, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body))
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(bytes.length))
  res.setHeader('Cache-Control', 'no-store')
  res.writeHead(status)
  res.end(bytes)
}

function responseHtml(res: any, status: number, html: string, extraHeaders: Record<string, string> = {}): void {
  const bytes = Buffer.from(html)
  for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value)
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Content-Length', String(bytes.length))
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.writeHead(status)
  res.end(bytes)
}

function escapeHtmlText(text: string): string {
  return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch)
}

function requireUid(url: URL): number {
  const raw = url.searchParams.get('uid')
  const uid = Number(raw)
  if (raw === null || !Number.isInteger(uid) || uid <= 0) {
    throw new InboxUsageError('uid 必须是正整数')
  }
  return uid
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(filename)
}

/** Message body document served straight into the sandboxed reader iframe. */
function messageHtmlDocument(html: string, text: string): string {
  const docStart = '<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_blank"></head><body>'
  if (html !== '') return docStart + html + '</body></html>'
  const limited = truncateText(text, TEXT_FALLBACK_CHARS).text
  return docStart
    + '<pre style="white-space:pre-wrap;word-wrap:break-word;font:14px/1.7 -apple-system,\'Segoe UI\',\'PingFang SC\',\'Microsoft YaHei\',sans-serif;margin:0;padding:12px;">'
    + escapeHtmlText(limited)
    + '</pre></body></html>'
}

async function handleInbox(getPool: () => EmailPool, req: any, res: any): Promise<void> {
  // Localhost-only, same policy as the settings route: full message content
  // must never leak to the LAN when the webserver binds 0.0.0.0.
  if (!isLoopbackRequest(req)) {
    responseJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'dsh-email inbox route is localhost-only' } })
    return
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET' } })
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const sub = url.pathname.slice(INBOX_ROUTE.length)
  const account = url.searchParams.get('account') ?? undefined
  const folder = url.searchParams.get('folder') ?? ''
  try {
    if (sub === '' || sub === '/') {
      responseHtml(res, 200, inboxPageHtml())
      return
    }
    if (sub === '/api/folders') {
      const pool = getPool()
      const value = await pool.folders(account, url.searchParams.get('subscribedOnly') === '1')
      responseJson(res, 200, { ok: true, value: { ...value, accounts: pool.accountNames() } })
      return
    }
    if (sub === '/api/messages') {
      const pool = getPool()
      const limit = clampInt(Number(url.searchParams.get('limit') ?? 20), 20, 1, 100)
      const offset = clampInt(Number(url.searchParams.get('offset') ?? 0), 0, 0, 100000)
      const value = await pool.list(account, folder, limit, offset, url.searchParams.get('unreadOnly') === '1')
      responseJson(res, 200, { ok: true, value })
      return
    }
    if (sub === '/api/message') {
      const uid = requireUid(url)
      const value = await getPool().read(account, uid, folder)
      responseJson(res, 200, { ok: true, value })
      return
    }
    if (sub === '/api/message.html') {
      const uid = requireUid(url)
      const source = await getPool().readSource(account, uid, folder)
      const view = await parseHtmlMessage(source, MAX_INLINE_IMAGE_BYTES)
      // CSP sandbox is the real security boundary: no scripts, no forms, no
      // network fetches; img-src data: blocks tracking pixels until the user
      // explicitly opts in with images=1.
      const csp = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"
        + (url.searchParams.get('images') === '1' ? ' http: https:' : '')
        + "; frame-ancestors 'self'"
      responseHtml(res, 200, messageHtmlDocument(view.html, view.text), { 'Content-Security-Policy': csp })
      return
    }
    if (sub === '/api/attachment') {
      const uid = requireUid(url)
      const index = clampInt(Number(url.searchParams.get('index') ?? 0), 0, 0, 999)
      const result = await getPool().downloadAttachment(account, folder, uid, index, undefined)
      const data = await readFile(result.path)
      res.setHeader('Content-Type', result.contentType || 'application/octet-stream')
      res.setHeader('Content-Disposition', contentDisposition(result.filename))
      res.setHeader('Content-Length', String(data.length))
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Cache-Control', 'no-store')
      res.writeHead(200)
      res.end(data)
      return
    }
    responseJson(res, 404, { ok: false, error: { code: 'not-found', message: 'Unknown inbox path: ' + sub } })
  } catch (error) {
    const message = messageOf(error, 'unknown error')
    const bad = error instanceof InboxUsageError || error instanceof MailError || message.startsWith('dsh-email')
    responseJson(res, bad ? 400 : 500, {
      ok: false,
      error: { code: bad ? 'bad-request' : 'internal', message },
    })
  }
}

/** Mount the read-only inbox page when a webServer service is present. */
export function installInboxWeb(ctx: any, getPool: () => EmailPool): void {
  ctx.inject(['webServer'], (webCtx: any) => {
    webCtx.effect(() => {
      const dispose = webCtx.webServer.register({
        kind: 'prefix',
        path: INBOX_ROUTE,
        handler: (req: any, res: any) => handleInbox(getPool, req, res),
      })
      return () => dispose()
    }, 'dsh-email: inbox web route')
  })
}

/** Self-contained read-only inbox page: no external assets (intranet-safe). */
function inboxPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-email 收件箱</title>
<style>
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; display: flex; flex-direction: column; font: 14px/1.6 -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; color: #1f2328; background: #f6f8fa; }
header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: #fff; border-bottom: 1px solid #d8dee4; flex: none; }
header h1 { font-size: 16px; margin: 0 8px 0 0; }
select, button { font: inherit; }
select { padding: 4px 8px; border: 1px solid #d0d7de; border-radius: 6px; background: #fff; max-width: 220px; }
button { padding: 4px 12px; border: 1px solid #d0d7de; border-radius: 6px; background: #f6f8fa; cursor: pointer; }
button:hover:not(:disabled) { background: #eaeef2; }
button:disabled { opacity: .5; cursor: default; }
label.chk { display: flex; align-items: center; gap: 4px; user-select: none; }
#banner { display: none; margin: 12px; padding: 10px 14px; border: 1px solid #d4a72c; background: #fff8c5; border-radius: 6px; }
main { flex: 1; display: flex; min-height: 0; }
#folders { width: 170px; flex: none; overflow: auto; padding: 8px; border-right: 1px solid #d8dee4; background: #fff; }
#folders button { display: block; width: 100%; text-align: left; margin-bottom: 2px; border: none; background: none; border-radius: 6px; padding: 6px 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#folders button:hover { background: #eef1f4; }
#folders button.active { background: #0969da; color: #fff; }
#listPane { width: 360px; flex: none; display: flex; flex-direction: column; border-right: 1px solid #d8dee4; background: #fff; min-height: 0; }
#messages { list-style: none; margin: 0; padding: 0; overflow: auto; flex: 1; }
#messages li { padding: 10px 12px; border-bottom: 1px solid #eaeef2; cursor: pointer; }
#messages li:hover { background: #f6f8fa; }
#messages li.active { background: #ddf4ff; }
#messages li.unread .subject { font-weight: 700; }
#messages li.hint { color: #8b949e; cursor: default; }
#messages .subject { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#messages .meta { color: #57606a; font-size: 12px; display: flex; gap: 8px; margin-top: 2px; }
#messages .meta .from { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge { display: inline-block; font-size: 11px; color: #0969da; border: 1px solid #0969da; border-radius: 8px; padding: 0 6px; margin-left: 6px; vertical-align: 1px; }
#more { margin: 8px; flex: none; }
#reader { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
#readerHead { padding: 12px 16px; background: #fff; border-bottom: 1px solid #d8dee4; flex: none; }
#readerHead h2 { font-size: 15px; margin: 0 0 6px; }
#readerHead .kv { color: #57606a; font-size: 12px; margin: 1px 0; word-break: break-all; }
#placeholder { color: #8b949e; padding: 24px; }
#toolbar { padding: 6px 12px; background: #fff; border-bottom: 1px solid #eaeef2; display: flex; gap: 8px; align-items: center; font-size: 12px; color: #57606a; flex: none; }
#frame { flex: 1; border: none; width: 100%; background: #fff; min-height: 0; }
#attach { padding: 8px 12px; background: #fff; border-top: 1px solid #eaeef2; font-size: 13px; flex: none; }
#attach a { color: #0969da; text-decoration: none; margin-right: 12px; }
footer { flex: none; padding: 4px 16px; background: #fff; border-top: 1px solid #d8dee4; color: #8b949e; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>收件箱</h1>
  <select id="account" title="账号"></select>
  <label class="chk"><input type="checkbox" id="unreadOnly"> 只看未读</label>
  <button id="refresh" type="button">刷新</button>
</header>
<div id="banner"></div>
<main>
  <nav id="folders"></nav>
  <section id="listPane">
    <ul id="messages"></ul>
    <button id="more" type="button" style="display:none">加载更多</button>
  </section>
  <article id="reader">
    <div id="readerHead"><div id="placeholder">在左侧选择一封邮件阅读。本页为只读视图，阅读不会把邮件标记为已读。</div></div>
    <div id="toolbar">
      <button id="remoteBtn" type="button" style="display:none">加载远程图片</button>
      <span>远程图片默认拦截（防追踪）；脚本一律禁用。</span>
    </div>
    <iframe id="frame" sandbox="" referrerpolicy="no-referrer" title="邮件正文"></iframe>
    <div id="attach" style="display:none"></div>
  </article>
</main>
<footer>只读收件箱：发信 / 回复请让 agent 执行（走审批确认）。-- dsh-email</footer>
<script>
(function () {
  'use strict';
  var BASE = '${INBOX_ROUTE}';
  var state = { account: '', folder: '', unreadOnly: false, offset: 0, limit: 20, uid: null, imagesAllowed: false };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtSize(n) {
    if (n > 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n > 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
  }
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
  }
  function qs(params) {
    var u = new URLSearchParams();
    Object.keys(params).forEach(function (k) {
      var v = params[k];
      if (v !== '' && v !== null && v !== undefined && v !== false) u.set(k, v);
    });
    var s = u.toString();
    return s ? '?' + s : '';
  }
  function api(path, params) {
    return fetch(BASE + path + qs(params)).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok || !data || !data.ok) {
          throw new Error((data && data.error && data.error.message) || ('HTTP ' + res.status));
        }
        return data.value;
      });
    });
  }
  function showBanner(msg) {
    var b = document.getElementById('banner');
    b.textContent = msg;
    b.style.display = 'block';
  }

  function loadFolders() {
    return api('/api/folders', { account: state.account }).then(function (value) {
      var accounts = value.accounts || [];
      var sel = document.getElementById('account');
      if (sel.children.length !== accounts.length) {
        sel.innerHTML = '';
        accounts.forEach(function (name) {
          var o = document.createElement('option');
          o.value = name;
          o.textContent = name;
          sel.appendChild(o);
        });
      }
      if (!state.account && accounts.length > 0) state.account = accounts[0];
      sel.value = state.account || '';
      var folders = value.folders || [];
      var known = folders.some(function (f) { return f.path === state.folder; });
      if (!known) {
        var inbox = folders.filter(function (f) {
          return f.specialUse === '\\\\Inbox' || String(f.path).toUpperCase() === 'INBOX';
        })[0];
        state.folder = (inbox || folders[0] || { path: '' }).path;
      }
      var nav = document.getElementById('folders');
      nav.innerHTML = '';
      folders.forEach(function (f) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.path = f.path;
        btn.textContent = f.name || f.path;
        btn.title = f.path + (f.specialUse ? ' [' + f.specialUse + ']' : '') + (f.subscribed ? '' : '（未订阅）');
        if (f.path === state.folder) btn.className = 'active';
        btn.onclick = function () {
          if (state.folder === f.path) return;
          state.folder = f.path;
          state.uid = null;
          state.offset = 0;
          markActiveFolder();
          loadList();
        };
        nav.appendChild(btn);
      });
    });
  }
  function markActiveFolder() {
    var btns = document.querySelectorAll('#folders button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].dataset.path === state.folder);
    }
  }

  function rowEl(m) {
    var li = document.createElement('li');
    li.dataset.uid = String(m.uid);
    if (!m.seen) li.classList.add('unread');
    if (m.uid === state.uid) li.classList.add('active');
    var subject = document.createElement('span');
    subject.className = 'subject';
    subject.textContent = m.subject || '(无主题)';
    li.appendChild(subject);
    if (m.hasAttachments) {
      var badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '附件';
      li.appendChild(badge);
    }
    var meta = document.createElement('div');
    meta.className = 'meta';
    var from = document.createElement('span');
    from.className = 'from';
    from.textContent = (m.from || []).map(function (a) { return a.name || a.address; }).filter(Boolean).join(', ') || '(未知)';
    var date = document.createElement('span');
    date.textContent = fmtDate(m.date);
    meta.appendChild(from);
    meta.appendChild(date);
    li.appendChild(meta);
    li.onclick = function () { openMessage(m.uid); };
    return li;
  }

  function loadList() {
    var listEl = document.getElementById('messages');
    if (state.offset === 0) listEl.innerHTML = '';
    return api('/api/messages', {
      account: state.account, folder: state.folder, limit: state.limit,
      offset: state.offset, unreadOnly: state.unreadOnly,
    }).then(function (value) {
      (value.messages || []).forEach(function (m) { listEl.appendChild(rowEl(m)); });
      var shown = listEl.children.length;
      var more = document.getElementById('more');
      more.style.display = shown < value.count ? '' : 'none';
      if (shown === 0) {
        var hint = document.createElement('li');
        hint.className = 'hint';
        hint.textContent = value.count === 0 ? '此文件夹没有邮件' : '没有更多邮件';
        listEl.appendChild(hint);
      }
    }).catch(function (err) { showBanner(err.message); });
  }

  function loadFrame() {
    var frame = document.getElementById('frame');
    frame.src = BASE + '/api/message.html' + qs({
      account: state.account, folder: state.folder, uid: state.uid, images: state.imagesAllowed,
    });
    var btn = document.getElementById('remoteBtn');
    btn.textContent = state.imagesAllowed ? '已允许远程图片' : '加载远程图片';
    btn.disabled = state.imagesAllowed;
  }

  function openMessage(uid) {
    state.uid = uid;
    state.imagesAllowed = false;
    var items = document.getElementById('messages').children;
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('active', Number(items[i].dataset.uid) === uid);
    }
    var head = document.getElementById('readerHead');
    head.innerHTML = '<div id="placeholder">加载中…</div>';
    api('/api/message', { account: state.account, folder: state.folder, uid: uid }).then(function (v) {
      var from = (v.from || []).map(function (a) { return a.name ? a.name + ' <' + a.address + '>' : a.address; }).join(', ') || '(未知)';
      var to = (v.to || []).map(function (a) { return a.address; }).join(', ');
      var cc = (v.cc || []).map(function (a) { return a.address; }).join(', ');
      head.innerHTML =
        '<h2>' + esc(v.subject || '(无主题)') + '</h2>' +
        '<div class="kv">发件人：' + esc(from) + '</div>' +
        '<div class="kv">收件人：' + esc(to) + '</div>' +
        (cc ? '<div class="kv">抄送：' + esc(cc) + '</div>' : '') +
        '<div class="kv">时间：' + esc(fmtDate(v.date)) + '</div>';
      var attach = document.getElementById('attach');
      attach.innerHTML = '';
      (v.attachments || []).forEach(function (a, i) {
        var link = document.createElement('a');
        link.href = BASE + '/api/attachment' + qs({ account: state.account, folder: state.folder, uid: uid, index: i });
        link.textContent = a.filename + '（' + fmtSize(a.size) + '）';
        attach.appendChild(link);
      });
      attach.style.display = (v.attachments && v.attachments.length > 0) ? '' : 'none';
      document.getElementById('remoteBtn').style.display = '';
      loadFrame();
    }).catch(function (err) {
      head.innerHTML = '<div id="placeholder">' + esc(err.message) + '</div>';
    });
  }

  document.getElementById('account').onchange = function () {
    state.account = this.value;
    state.folder = '';
    state.uid = null;
    state.offset = 0;
    loadFolders().then(loadList);
  };
  document.getElementById('unreadOnly').onchange = function () {
    state.unreadOnly = this.checked;
    state.offset = 0;
    loadList();
  };
  document.getElementById('refresh').onclick = function () {
    state.offset = 0;
    state.uid = null;
    loadFolders().then(loadList);
  };
  document.getElementById('more').onclick = function () {
    state.offset += state.limit;
    loadList();
  };
  document.getElementById('remoteBtn').onclick = function () {
    state.imagesAllowed = true;
    loadFrame();
  };

  loadFolders().then(loadList).catch(function (err) {
    showBanner(err.message + '（若尚未配置账号，请到 dsh 设置 -> 邮件 (dsh-email) 填写并保存）');
  });
})();
</script>
</body>
</html>`
}
