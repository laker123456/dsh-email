import test from 'node:test'
import assert from 'node:assert/strict'
import { INBOX_ROUTE, installInboxWeb } from '../lib/index.js'

const RAW_HTML_MAIL = [
  'From: Alice <alice@example.com>',
  'To: me@example.com',
  'Subject: HTML mail',
  'MIME-Version: 1.0',
  'Content-Type: multipart/related; boundary="b"',
  '',
  '--b',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>你好</p><img src="cid:img1"><img src="https://tracker.example/pixel.gif">',
  '--b',
  'Content-Type: image/png',
  'Content-ID: <img1>',
  'Content-Disposition: inline',
  'Content-Transfer-Encoding: base64',
  '',
  'iVBORw0KGgo=',
  '--b--',
].join('\r\n')

const RAW_TEXT_MAIL = 'From: a@b.c\r\nTo: me@example.com\r\nSubject: plain\r\nContent-Type: text/plain\r\n\r\n纯文本内容'

function installRoute(getPool) {
  const holder = { routes: [], disposers: [] }
  const webCtx = {
    effect(fn) { holder.disposers.push(fn()) },
    webServer: {
      register(route) {
        holder.routes.push(route)
        return () => holder.routes.splice(holder.routes.indexOf(route), 1)
      },
    },
  }
  const ctx = { inject(names, cb) { if (names.includes('webServer')) cb(webCtx) } }
  installInboxWeb(ctx, getPool)
  return holder
}

function fakeReq(path, remoteAddress = '127.0.0.1') {
  return { method: 'GET', url: path, socket: { remoteAddress } }
}

function fakeRes() {
  return {
    headers: {}, statusCode: 0, chunks: [], ended: false,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value },
    writeHead(code) { this.statusCode = code },
    write(chunk) { this.chunks.push(Buffer.from(chunk)) },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(Buffer.from(chunk))
      this.ended = true
    },
    body() { return Buffer.concat(this.chunks).toString('utf8') },
    json() { return JSON.parse(this.body()) },
  }
}

async function call(route, req) {
  const res = fakeRes()
  await route.handler(req, res)
  return res
}

test('inbox registers a prefix route and disposes cleanly', () => {
  const holder = installRoute(() => { throw new Error('no pool') })
  assert.equal(holder.routes.length, 1)
  assert.equal(holder.routes[0].kind, 'prefix')
  assert.equal(holder.routes[0].path, INBOX_ROUTE)
  holder.disposers.forEach(dispose => dispose())
  assert.equal(holder.routes.length, 0)
})

test('inbox route rejects non-loopback clients on every path', async () => {
  const holder = installRoute(() => { throw new Error('no pool') })
  const route = holder.routes[0]
  for (const path of ['', '/', '/api/messages', '/api/message.html?uid=1']) {
    const res = await call(route, fakeReq(INBOX_ROUTE + path, '192.168.1.5'))
    assert.equal(res.statusCode, 403, path)
    assert.equal(res.json().error.code, 'forbidden')
  }
})

test('inbox page is served as no-store HTML', async () => {
  const holder = installRoute(() => { throw new Error('no pool') })
  const res = await call(holder.routes[0], fakeReq(INBOX_ROUTE))
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'], /text\/html/)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.ok(res.body().includes('收件箱'))
  assert.ok(res.body().includes(INBOX_ROUTE))
})

test('inbox rejects non-GET methods with 405', async () => {
  const holder = installRoute(() => { throw new Error('no pool') })
  const res = await call(holder.routes[0], { ...fakeReq(INBOX_ROUTE + '/api/messages'), method: 'POST' })
  assert.equal(res.statusCode, 405)
  assert.equal(res.headers.allow, 'GET')
})

test('unknown inbox sub-path answers 404', async () => {
  const holder = installRoute(() => { throw new Error('no pool') })
  const res = await call(holder.routes[0], fakeReq(INBOX_ROUTE + '/api/nope'))
  assert.equal(res.statusCode, 404)
})

test('unconfigured account maps to a 400 envelope with the actionable message', async () => {
  const holder = installRoute(() => { throw new Error('dsh-email 未配置：user（邮箱地址）未填写') })
  const res = await call(holder.routes[0], fakeReq(INBOX_ROUTE + '/api/messages'))
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error.code, 'bad-request')
  assert.match(res.json().error.message, /未配置/)
})

test('invalid uid answers 400 instead of touching the pool', async () => {
  let poolCalls = 0
  const holder = installRoute(() => { poolCalls += 1; throw new Error('should not be reached') })
  for (const uid of ['', 'abc', '0', '-3']) {
    const suffix = uid === '' ? '' : '?uid=' + uid
    const res = await call(holder.routes[0], fakeReq(INBOX_ROUTE + '/api/message' + suffix))
    assert.equal(res.statusCode, 400, 'uid=' + uid)
  }
  assert.equal(poolCalls, 0)
})

test('message.html serves CSP-sandboxed HTML with cid images inlined', async () => {
  const holder = installRoute(() => ({ readSource: async () => Buffer.from(RAW_HTML_MAIL) }))
  const route = holder.routes[0]

  const blocked = await call(route, fakeReq(INBOX_ROUTE + '/api/message.html?uid=5'))
  assert.equal(blocked.statusCode, 200)
  assert.match(blocked.headers['content-type'], /text\/html/)
  const csp = blocked.headers['content-security-policy']
  assert.match(csp, /^sandbox;/)
  assert.match(csp, /default-src 'none'/)
  assert.match(csp, /img-src data:;/)
  assert.match(csp, /frame-ancestors 'self'/)
  assert.ok(blocked.body().includes('data:image/png;base64,'))
  assert.ok(!blocked.body().includes('cid:img1'))
  assert.ok(blocked.body().includes('你好'))

  const allowed = await call(route, fakeReq(INBOX_ROUTE + '/api/message.html?uid=5&images=1'))
  assert.match(allowed.headers['content-security-policy'], /img-src data: http: https:/)
})

test('message.html falls back to an escaped plain-text document', async () => {
  const holder = installRoute(() => ({ readSource: async () => Buffer.from(RAW_TEXT_MAIL) }))
  const res = await call(holder.routes[0], fakeReq(INBOX_ROUTE + '/api/message.html?uid=3'))
  assert.equal(res.statusCode, 200)
  assert.ok(res.body().includes('<pre'))
  assert.ok(res.body().includes('纯文本内容'))
})
