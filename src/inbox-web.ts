import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { clampInt, PROVIDER_NAMES, PROVIDER_PRESETS } from './config.js'
import { EmailPool, MailError, messageOf } from './mail-client.js'
import { parseHtmlMessage, truncateText } from './parse.js'
import { SETTINGS_NAMESPACE, validateSettingsValue, type EmailSettingsValue } from './settings.js'
import { isLoopbackRequest } from './web.js'

export const INBOX_ROUTE = '/_dsh/dsh-email/inbox'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = join(MODULE_DIR, '..', 'assets')

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

async function readJsonBody(req: any, maxBytes = 64 * 1024): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (chunks.reduce((n, c) => n + c.length, 0) + part.length > maxBytes) throw new RangeError('request body too large')
    chunks.push(part)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** POST /api/mark-seen: flip \\Seen on a message so the inbox list updates. */
async function handleMarkSeen(getPool: () => EmailPool, req: any, res: any): Promise<void> {
  let body: any
  try {
    body = await readJsonBody(req)
  } catch (error) {
    responseJson(res, 400, { ok: false, error: { code: 'invalid-request', message: messageOf(error, 'invalid request body') } })
    return
  }
  const uid = Number(body?.uid)
  const account = typeof body?.account === 'string' && body.account !== '' ? body.account : undefined
  const folder = typeof body?.folder === 'string' && body.folder !== '' ? body.folder : ''
  if (!Number.isInteger(uid) || uid <= 0) {
    responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'uid 必须是正整数' } })
    return
  }
  if (folder === '') {
    responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'folder 不能为空' } })
    return
  }
  try {
    await getPool().markSeen(account, uid, folder)
    responseJson(res, 200, { ok: true })
  } catch (error) {
    const message = messageOf(error, '标记已读失败')
    const bad = error instanceof MailError || message.startsWith('dsh-email')
    responseJson(res, bad ? 400 : 500, { ok: false, error: { code: bad ? 'bad-request' : 'internal', message } })
  }
}

/** POST /api/send: send a message straight from the inbox page (no agent approval). */
async function handleSend(getPool: () => EmailPool, req: any, res: any): Promise<void> {
  let body: any
  try { body = await readJsonBody(req, 256 * 1024) } catch (error) {
    responseJson(res, 400, { ok: false, error: { code: 'invalid-request', message: messageOf(error, 'invalid request body') } })
    return
  }
  const account = typeof body?.account === 'string' && body.account !== '' ? body.account : undefined
  const to = typeof body?.to === 'string' ? body.to.trim() : ''
  const subject = typeof body?.subject === 'string' ? body.subject.trim() : ''
  const text = typeof body?.text === 'string' ? body.text : ''
  const html = typeof body?.html === 'string' ? body.html : ''
  const cc = typeof body?.cc === 'string' ? body.cc.trim() : ''
  const bcc = typeof body?.bcc === 'string' ? body.bcc.trim() : ''
  const attachments = Array.isArray(body?.attachments) ? body.attachments.filter((p: any) => typeof p === 'string' && p !== '') : []
  if (to === '') {
    responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: '收件人不能为空' } })
    return
  }
  if (subject === '' && text === '' && html === '') {
    responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: '主题和正文不能同时为空' } })
    return
  }
  try {
    const value = await getPool().send(account, to, subject, text || undefined, html || undefined, cc || undefined, bcc || undefined, attachments.length > 0 ? attachments : undefined)
    responseJson(res, 200, { ok: true, value })
  } catch (error) {
    const message = messageOf(error, '发信失败')
    const bad = error instanceof MailError || message.startsWith('dsh-email')
    responseJson(res, bad ? 400 : 500, { ok: false, error: { code: bad ? 'bad-request' : 'internal', message } })
  }
}

/** POST /api/upload: accept a multipart file upload, write to a deterministic temp path, return the absolute path. */
async function handleUpload(req: any, res: any): Promise<void> {
  const contentType = String(req.headers['content-type'] ?? '')
  const boundaryMatch = contentType.match(/boundary=(.+)$/i)
  if (!boundaryMatch) {
    responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'expected multipart/form-data' } })
    return
  }
  const boundary = '--' + boundaryMatch[1]
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (chunks.reduce((n, c) => n + c.length, 0) + part.length > 25 * 1024 * 1024) {
      responseJson(res, 413, { ok: false, error: { code: 'too-large', message: '附件超过 25MB 上限' } })
      return
    }
    chunks.push(part)
  }
  const buf = Buffer.concat(chunks)
  // Split on boundary, parse each part's headers + body.
  const parts: Array<{ filename: string; data: Buffer }> = []
  const sep = Buffer.from('\r\n')
  let cursor = 0
  while (cursor < buf.length) {
    const startIdx = buf.indexOf(boundary, cursor)
    if (startIdx < 0) break
    const nextIdx = buf.indexOf(boundary, startIdx + boundary.length)
    if (nextIdx < 0) break
    const partBuf = buf.subarray(startIdx + boundary.length + 2, nextIdx - 2) // -2 strips trailing \r\n before boundary
    cursor = nextIdx
    const headerEnd = partBuf.indexOf('\r\n\r\n')
    if (headerEnd < 0) continue
    const headerStr = partBuf.subarray(0, headerEnd).toString('utf8')
    const data = partBuf.subarray(headerEnd + 4)
    const dispMatch = headerStr.match(/Content-Disposition:[^\r\n]+/i)
    if (!dispMatch) continue
    const fnameMatch = dispMatch[0].match(/filename="([^"]*)"/i)
    if (!fnameMatch || fnameMatch[1] === '') continue
    parts.push({ filename: fnameMatch[1], data })
  }
  if (parts.length === 0) {
    responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: '未找到附件文件' } })
    return
  }
  const outPaths: string[] = []
  for (const p of parts) {
    const safeName = p.filename.replace(/[^\w.\u4e00-\u9fa5-]/g, '_')
    const dir = join(tmpdir(), 'dsh-email-uploads')
    await mkdir(dir, { recursive: true })
    const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8)
    const full = join(dir, stamp + '-' + safeName)
    await writeFile(full, p.data)
    outPaths.push(full)
  }
  responseJson(res, 200, { ok: true, value: { paths: outPaths } })
}

/** POST /api/login: write {provider, user, password} into the settings scope. */
async function handleLogin(settingsScope: any, ctx: any, req: any, res: any): Promise<void> {
  let body: any
  try {
    body = await readJsonBody(req)
  } catch (error) {
    responseJson(res, 400, { ok: false, error: { code: 'invalid-request', message: messageOf(error, 'invalid request body') } })
    return
  }
  const provider = typeof body?.provider === 'string' ? body.provider.trim() : ''
  const user = typeof body?.user === 'string' ? body.user.trim() : ''
  const password = typeof body?.password === 'string' ? body.password : ''
  if (!user) {
    responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: '邮箱地址不能为空' } })
    return
  }
  if (!password) {
    responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'AD密码不能为空' } })
    return
  }
  if (provider !== '' && !PROVIDER_NAMES.includes(provider as any)) {
    responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: '未知的 provider，可选：' + PROVIDER_NAMES.join('/') } })
    return
  }
  try {
    if (ctx.settings.writable === false) throw new Error('settings provider is read-only')
    const current = settingsScope.get() as EmailSettingsValue
    const preset = PROVIDER_PRESETS[provider]
    // Non-coremail providers: write the preset's imap/smtp host/port/secure
    // alongside the credentials, because the settings schema defaults host to
    // '' and toEmailConfig treats an empty string as "user explicitly cleared
    // the host" — which would shadow the provider preset and break login.
    const next: EmailSettingsValue = preset
      ? { ...current, provider, user, password, imap: { ...preset.imap }, smtp: { ...preset.smtp } }
      : { ...current, provider, user, password }
    validateSettingsValue(next)
    const descriptor = (ctx.settings.describe?.() ?? []).find((row: any) => row.ns === SETTINGS_NAMESPACE)
    const expectedRevision = descriptor?.revision ?? 0
    await ctx.settings.replace(SETTINGS_NAMESPACE, next, expectedRevision)
    responseJson(res, 200, { ok: true })
  } catch (error) {
    const conflict = (error as any)?.code === 'SETTINGS_CONFLICT'
    responseJson(res, conflict ? 409 : 400, {
      ok: false,
      error: { code: conflict ? 'conflict' : 'bad-request', message: messageOf(error, '保存失败') },
    })
  }
}

/** POST /api/logout: clear saved password so the login page reappears on next load. */
async function handleLogout(settingsScope: any, ctx: any, req: any, res: any): Promise<void> {
  try {
    await mutateSettings(settingsScope, ctx, (current) => ({ ...current, password: '' }))
    responseJson(res, 200, { ok: true })
  } catch (error) {
    const conflict = (error as any)?.code === 'SETTINGS_CONFLICT'
    responseJson(res, conflict ? 409 : 400, { ok: false, error: { code: conflict ? 'conflict' : 'bad-request', message: messageOf(error, '退出失败') } })
  }
}

/** Read-modify-write the settings scope with optimistic concurrency. */
async function mutateSettings(settingsScope: any, ctx: any, mutate: (current: EmailSettingsValue) => EmailSettingsValue): Promise<void> {
  if (ctx.settings.writable === false) throw new Error('settings provider is read-only')
  const current = settingsScope.get() as EmailSettingsValue
  const next = mutate(current)
  validateSettingsValue(next)
  const descriptor = (ctx.settings.describe?.() ?? []).find((row: any) => row.ns === SETTINGS_NAMESPACE)
  const expectedRevision = descriptor?.revision ?? 0
  await ctx.settings.replace(SETTINGS_NAMESPACE, next, expectedRevision)
}

/** GET /api/labels → return the stored labels array. */
function handleListLabels(settingsScope: any, res: any): void {
  const value = settingsScope.get() as EmailSettingsValue
  responseJson(res, 200, { ok: true, value: value.labels ?? [] })
}

/** POST /api/labels → create or update a label by id. */
async function handleSaveLabel(getPool: () => EmailPool, settingsScope: any, ctx: any, req: any, res: any): Promise<void> {
  let body: any
  try { body = await readJsonBody(req) } catch (error) {
    responseJson(res, 400, { ok: false, error: { code: 'invalid-request', message: messageOf(error, 'invalid request body') } })
    return
  }
  const id = typeof body?.id === 'string' ? body.id.trim() : ''
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const color = typeof body?.color === 'string' ? body.color.trim() : ''
  const keywords = Array.isArray(body?.keywords) ? body.keywords.map((k: any) => String(k).trim()).filter((k: string) => k !== '') : []
  if (id === '' || name === '') {
    responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'id 和 name 不能为空' } })
    return
  }
  try {
    await mutateSettings(settingsScope, ctx, (current) => {
      const labels = (current.labels ?? []).slice()
      const idx = labels.findIndex(l => l.id === id)
      const label = { id, name, keywords, color }
      if (idx >= 0) labels[idx] = label
      else labels.push(label)
      return { ...current, labels }
    })
    getPool().invalidateLabelCache()
    responseJson(res, 200, { ok: true })
  } catch (error) {
    const conflict = (error as any)?.code === 'SETTINGS_CONFLICT'
    responseJson(res, conflict ? 409 : 400, { ok: false, error: { code: conflict ? 'conflict' : 'bad-request', message: messageOf(error, '保存失败') } })
  }
}

/** POST /api/labels/delete → remove a label by id. */
async function handleDeleteLabel(getPool: () => EmailPool, settingsScope: any, ctx: any, req: any, res: any): Promise<void> {
  let body: any
  try { body = await readJsonBody(req) } catch (error) {
    responseJson(res, 400, { ok: false, error: { code: 'invalid-request', message: messageOf(error, 'invalid request body') } })
    return
  }
  const id = typeof body?.id === 'string' ? body.id.trim() : ''
  if (id === '') {
    responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'id 不能为空' } })
    return
  }
  try {
    await mutateSettings(settingsScope, ctx, (current) => {
      const labels = (current.labels ?? []).filter(l => l.id !== id)
      return { ...current, labels }
    })
    getPool().invalidateLabelCache()
    responseJson(res, 200, { ok: true })
  } catch (error) {
    const conflict = (error as any)?.code === 'SETTINGS_CONFLICT'
    responseJson(res, conflict ? 409 : 400, { ok: false, error: { code: conflict ? 'conflict' : 'bad-request', message: messageOf(error, '删除失败') } })
  }
}

/** Common body parsing + validation for flag-toggling routes (toggle-seen, pin). */
async function handleFlagToggle(getPool: () => EmailPool, req: any, res: any, op: 'seen' | 'pin'): Promise<void> {
  let body: any
  try { body = await readJsonBody(req) } catch (error) {
    responseJson(res, 400, { ok: false, error: { code: 'invalid-request', message: messageOf(error, 'invalid request body') } })
    return
  }
  const uid = Number(body?.uid)
  const account = typeof body?.account === 'string' && body.account !== '' ? body.account : undefined
  const folder = typeof body?.folder === 'string' && body.folder !== '' ? body.folder : ''
  const on = Boolean(body?.on)
  if (!Number.isInteger(uid) || uid <= 0) {
    responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'uid 必须是正整数' } })
    return
  }
  if (folder === '') {
    responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'folder 不能为空' } })
    return
  }
  try {
    if (op === 'seen') await getPool().toggleSeen(account, uid, folder, on)
    else await getPool().flagPinned(account, uid, folder, on)
    responseJson(res, 200, { ok: true })
  } catch (error) {
    const message = messageOf(error, op === 'seen' ? '切换已读失败' : '置顶失败')
    responseJson(res, 500, { ok: false, error: { code: 'internal', message } })
  }
}

async function handleToggleSeen(getPool: () => EmailPool, req: any, res: any): Promise<void> {
  await handleFlagToggle(getPool, req, res, 'seen')
}

async function handlePin(getPool: () => EmailPool, req: any, res: any): Promise<void> {
  await handleFlagToggle(getPool, req, res, 'pin')
}

/** POST /api/move → move a message to another folder (e.g. trash). */
async function handleMove(getPool: () => EmailPool, req: any, res: any): Promise<void> {
  let body: any
  try { body = await readJsonBody(req) } catch (error) {
    responseJson(res, 400, { ok: false, error: { code: 'invalid-request', message: messageOf(error, 'invalid request body') } })
    return
  }
  const uid = Number(body?.uid)
  const account = typeof body?.account === 'string' && body.account !== '' ? body.account : undefined
  const folder = typeof body?.folder === 'string' && body.folder !== '' ? body.folder : ''
  const target = typeof body?.target === 'string' && body.target !== '' ? body.target : ''
  if (!Number.isInteger(uid) || uid <= 0) {
    responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'uid 必须是正整数' } })
    return
  }
  if (folder === '' || target === '') {
    responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'folder 和 target 不能为空' } })
    return
  }
  try {
    await getPool().moveMessage(account, uid, folder, target)
    responseJson(res, 200, { ok: true })
  } catch (error) {
    const message = messageOf(error, '移动邮件失败')
    responseJson(res, 500, { ok: false, error: { code: 'internal', message } })
  }
}

function handleListTodos(settingsScope: any, res: any): void {
  const value = settingsScope.get() as EmailSettingsValue
  responseJson(res, 200, { ok: true, value: value.todos ?? [] })
}

/** POST /api/todos → add a message to the todo box. */
async function handleSaveTodo(getPool: () => EmailPool, settingsScope: any, ctx: any, req: any, res: any): Promise<void> {
  let body: any
  try { body = await readJsonBody(req) } catch (error) {
    responseJson(res, 400, { ok: false, error: { code: 'invalid-request', message: messageOf(error, 'invalid request body') } })
    return
  }
  const uid = Number(body?.uid)
  const account = typeof body?.account === 'string' ? body.account.trim() : ''
  const folder = typeof body?.folder === 'string' ? body.folder.trim() : ''
  const subject = typeof body?.subject === 'string' ? body.subject : ''
  const from = typeof body?.from === 'string' ? body.from : ''
  const date = typeof body?.date === 'string' ? body.date : ''
  const seen = !!body?.seen
  if (!Number.isInteger(uid) || uid <= 0 || folder === '') {
    responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'uid 和 folder 不能为空' } })
    return
  }
  const id = 'todo_' + uid + '_' + folder + '_' + Date.now()
  try {
    await mutateSettings(settingsScope, ctx, (current) => {
      const todos = (current.todos ?? []).slice()
      if (!todos.some(t => t.uid === uid && t.folder === folder && t.account === account)) {
        todos.push({ id, account, folder, uid, subject, from, date, seen, addedAt: Date.now() })
      }
      return { ...current, todos }
    })
    responseJson(res, 200, { ok: true })
  } catch (error) {
    const conflict = (error as any)?.code === 'SETTINGS_CONFLICT'
    responseJson(res, conflict ? 409 : 400, { ok: false, error: { code: conflict ? 'conflict' : 'bad-request', message: messageOf(error, '添加待办失败') } })
  }
}

/** POST /api/todos/sync → pull \Flagged messages from the server and merge into todos. */
async function handleSyncTodos(getPool: () => EmailPool, settingsScope: any, ctx: any, req: any, res: any): Promise<void> {
  let body: any = {}
  try { body = await readJsonBody(req) } catch { /* empty body is fine */ }
  const account = typeof body?.account === 'string' ? body.account.trim() : ''
  const limit = Number.isInteger(body?.limit) && body.limit > 0 ? body.limit : 200
  try {
    const pool = getPool()
    const result = await pool.listFlagged(account || undefined, limit)
    const flagged = result.messages
    const accountName = result.account || account || 'default'
    const fromStr = (m: { from?: any[] }): string => {
      const a = Array.isArray(m.from) ? m.from[0] : m.from
      if (!a) return ''
      if (typeof a === 'string') return a
      return a.name ? `${a.name} <${a.address || ''}>` : (a.address || '')
    }
    const before = ((settingsScope.get() as EmailSettingsValue)?.todos ?? []).length
    await mutateSettings(settingsScope, ctx, (current) => {
      const existing = (current.todos ?? []).slice()
      const key = (t: { account: string; folder: string; uid: number }) => t.account + '|' + t.folder + '|' + t.uid
      const have = new Set(existing.map(key))
      for (const m of flagged) {
        const k = accountName + '|' + (m.folder || '') + '|' + m.uid
        if (!have.has(k)) {
          existing.push({
            id: 'todo_' + m.uid + '_' + (m.folder || '') + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            account: accountName,
            folder: m.folder || '',
            uid: m.uid,
            subject: m.subject || '',
            from: fromStr(m),
            date: m.date || '',
            seen: !!m.seen,
            addedAt: Date.now(),
          })
          have.add(k)
        }
      }
      return { ...current, todos: existing }
    })
    const after = ((settingsScope.get() as EmailSettingsValue)?.todos ?? []).length
    responseJson(res, 200, { ok: true, value: { synced: Math.max(0, after - before), total: after } })
  } catch (error) {
    responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: messageOf(error, '同步待办失败') } })
  }
}

/** POST /api/todos/delete → remove a todo entry by id. */
async function handleDeleteTodo(getPool: () => EmailPool, settingsScope: any, ctx: any, req: any, res: any): Promise<void> {
  let body: any
  try { body = await readJsonBody(req) } catch (error) {
    responseJson(res, 400, { ok: false, error: { code: 'invalid-request', message: messageOf(error, 'invalid request body') } })
    return
  }
  const id = typeof body?.id === 'string' ? body.id.trim() : ''
  if (id === '') {
    responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'id 不能为空' } })
    return
  }
  try {
    await mutateSettings(settingsScope, ctx, (current) => {
      const todos = (current.todos ?? []).filter(t => t.id !== id)
      return { ...current, todos }
    })
    responseJson(res, 200, { ok: true })
  } catch (error) {
    const conflict = (error as any)?.code === 'SETTINGS_CONFLICT'
    responseJson(res, conflict ? 409 : 400, { ok: false, error: { code: conflict ? 'conflict' : 'bad-request', message: messageOf(error, '删除待办失败') } })
  }
}

async function handleInbox(getPool: () => EmailPool, settingsScope: any, ctx: any, req: any, res: any): Promise<void> {
  // Localhost-only, same policy as the settings route: full message content
  // must never leak to the LAN when the webserver binds 0.0.0.0.
  if (!isLoopbackRequest(req)) {
    responseJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'dsh-email inbox route is localhost-only' } })
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const sub = url.pathname.slice(INBOX_ROUTE.length)

  if (req.method === 'POST' && sub === '/api/login') {
    await handleLogin(settingsScope, ctx, req, res)
    return
  }
  if (req.method === 'POST' && sub === '/api/logout') {
    await handleLogout(settingsScope, ctx, req, res)
    return
  }
  if (req.method === 'POST' && sub === '/api/mark-seen') {
    await handleMarkSeen(getPool, req, res)
    return
  }
  if (req.method === 'POST' && sub === '/api/toggle-seen') {
    await handleToggleSeen(getPool, req, res)
    return
  }
  if (req.method === 'POST' && sub === '/api/move') {
    await handleMove(getPool, req, res)
    return
  }
  if (req.method === 'POST' && sub === '/api/pin') {
    await handlePin(getPool, req, res)
    return
  }
  if (req.method === 'GET' && sub === '/api/todos') {
    handleListTodos(settingsScope, res)
    return
  }
  if (req.method === 'POST' && sub === '/api/todos') {
    await handleSaveTodo(getPool, settingsScope, ctx, req, res)
    return
  }
  if (req.method === 'POST' && sub === '/api/todos/delete') {
    await handleDeleteTodo(getPool, settingsScope, ctx, req, res)
    return
  }
  if (req.method === 'POST' && sub === '/api/todos/sync') {
    await handleSyncTodos(getPool, settingsScope, ctx, req, res)
    return
  }
  if (req.method === 'POST' && sub === '/api/send') {
    await handleSend(getPool, req, res)
    return
  }
  if (req.method === 'POST' && sub === '/api/upload') {
    await handleUpload(req, res)
    return
  }
  if (req.method === 'GET' && sub === '/api/labels') {
    handleListLabels(settingsScope, res)
    return
  }
  if (req.method === 'POST' && sub === '/api/labels') {
    await handleSaveLabel(getPool, settingsScope, ctx, req, res)
    return
  }
  if (req.method === 'POST' && sub === '/api/labels/delete') {
    await handleDeleteLabel(getPool, settingsScope, ctx, req, res)
    return
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET' } })
    return
  }
  const account = url.searchParams.get('account') ?? undefined
  const folder = url.searchParams.get('folder') ?? ''
  try {
    if (sub === '' || sub === '/') {
      responseHtml(res, 200, inboxPageHtml())
      return
    }
    if (sub === '/api/asset/emailAI.png') {
      try {
        const data = await readFile(join(ASSET_DIR, 'emailAI.png'))
        res.setHeader('Content-Type', 'image/png')
        res.setHeader('Content-Length', String(data.length))
        res.setHeader('Cache-Control', 'no-store')
        res.writeHead(200)
        res.end(data)
      } catch {
        responseJson(res, 404, { ok: false, error: { code: 'not-found', message: 'asset missing' } })
      }
      return
    }
    if (sub === '/api/asset/emialLogo.png' || sub === '/api/asset/email-logo.png') {
      try {
        const file = sub === '/api/asset/email-logo.png' ? 'email-logo.png' : 'emialLogo.png'
        const data = await readFile(join(ASSET_DIR, file))
        res.setHeader('Content-Type', 'image/png')
        res.setHeader('Content-Length', String(data.length))
        res.setHeader('Cache-Control', 'no-store')
        res.writeHead(200)
        res.end(data)
      } catch {
        responseJson(res, 404, { ok: false, error: { code: 'not-found', message: 'asset missing' } })
      }
      return
    }
    if (sub === '/api/asset/assistant.html') {
      try {
        const data = await readFile(join(ASSET_DIR, '智能助手页面.html'))
        const bytes = Buffer.from(data)
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.setHeader('Content-Length', String(bytes.length))
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('X-Content-Type-Options', 'nosniff')
        res.writeHead(200)
        res.end(bytes)
      } catch {
        responseJson(res, 404, { ok: false, error: { code: 'not-found', message: 'asset missing' } })
      }
      return
    }
    if (sub === '/api/me') {
      const pool = getPool()
      const name = pool.resolveName(account)
      try {
        const cfg = pool.account(name)
        responseJson(res, 200, { ok: true, value: { account: name, user: cfg.user ?? '' } })
      } catch (error) {
        responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: messageOf(error, '未配置') } })
      }
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
      const labelId = url.searchParams.get('label')
      if (labelId) {
        const sv = settingsScope.get() as EmailSettingsValue
        const label = (sv.labels ?? []).find(l => l.id === labelId)
        if (!label) {
          responseJson(res, 404, { ok: false, error: { code: 'not-found', message: '标签不存在：' + labelId } })
          return
        }
        const value = await pool.listByLabel(account, label.keywords, limit)
        responseJson(res, 200, { ok: true, value })
        return
      }
      const offset = clampInt(Number(url.searchParams.get('offset') ?? 0), 0, 0, 100000)
      const value = await pool.list(account, folder, limit, offset, url.searchParams.get('unreadOnly') === '1')
      responseJson(res, 200, { ok: true, value })
      return
    }
    if (sub === '/api/search') {
      const pool = getPool()
      const q = (url.searchParams.get('q') ?? '').trim()
      if (q === '') {
        responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'q 不能为空' } })
        return
      }
      const limit = clampInt(Number(url.searchParams.get('limit') ?? 50), 50, 1, 200)
      const folderName = folder || pool.resolveName(account) && pool.account(pool.resolveName(account)).inboxFolder || 'INBOX'
      const value = await pool.search(account, q, folderName, limit)
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
export function installInboxWeb(ctx: any, getPool: () => EmailPool, settingsScope: any): void {
  ctx.inject(['webServer'], (webCtx: any) => {
    webCtx.effect(() => {
      const dispose = webCtx.webServer.register({
        kind: 'prefix',
        path: INBOX_ROUTE,
        handler: (req: any, res: any) => handleInbox(getPool, settingsScope, ctx, req, res),
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
<title>WeBank 邮箱 - 收件箱</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body {
  font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
  color: #333; background: #f4f6f9; display: flex; flex-direction: column; height: 100vh; overflow: hidden;
}
button, select, input { font: inherit; }

/* 顶栏 */
.header {
  height: 52px; background: #f0f3f8; border-bottom: 1px solid #e1e6ed;
  display: flex; align-items: center; justify-content: space-between; padding: 0 16px; flex-shrink: 0;
}
.logo-area { display: flex; align-items: center; width: 210px; }
.logo-title { font-size: 20px; font-weight: bold; color: #1262d6; display: flex; align-items: center; gap: 6px; }
.logo-title .logo-sub { font-size: 10px; color: #1262d6; font-weight: normal; line-height: 1.1; }
.search-bar { flex: 1; max-width: 480px; position: relative; margin: 0 16px; }
.search-bar input {
  width: 100%; height: 32px; background: #e2e7ef; border: 1px solid transparent;
  border-radius: 16px; padding: 0 16px 0 36px; font-size: 13px; outline: none; color: #333;
}
.search-bar input:focus { background: #fff; border-color: #0084ff; }
.search-bar i { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: #8a97a8; }
.user-area { display: flex; align-items: center; gap: 12px; font-size: 12px; color: #555; }

/* 主体 */
.main-container { display: flex; flex: 1; overflow: hidden; }

/* 左侧栏 */
.sidebar {
  width: 210px; background: #ebf0f5; border-right: 1px solid #dce2e9;
  display: flex; flex-direction: column; padding: 12px 8px; overflow-y: auto; flex-shrink: 0;
}
.sidebar-action-row {
  display: flex; gap: 8px; margin-bottom: 12px;
}
.sidebar-action-row .btn-compose { flex: 1 1 0; margin-bottom: 0; }
.btn-fetch {
  flex: 1 1 0; background: #fff; color: #2b80ff; border: 1px solid #2b80ff;
  border-radius: 6px; padding: 8px 12px; font-size: 13px; font-weight: 500;
  display: flex; align-items: center; justify-content: center; gap: 6px; cursor: pointer;
  box-shadow: 0 2px 4px rgba(0,86,224,0.08);
}
.btn-fetch:hover { background: #f0f6ff; }
.btn-compose {
  background: linear-gradient(135deg, #2b80ff, #0056e0); color: #fff; border: none;
  border-radius: 6px; padding: 8px 16px; font-size: 13px; font-weight: 500;
  display: flex; align-items: center; justify-content: center; gap: 6px; cursor: pointer;
  box-shadow: 0 2px 4px rgba(0,86,224,0.2);
}
.btn-compose:hover { filter: brightness(1.05); }
.menu-group { margin-bottom: 8px; }
.menu-title { font-size: 11px; color: #8a97a8; padding: 4px 12px; }
.menu-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 5px 12px; border-radius: 6px; color: #333; cursor: pointer;
  font-size: 13px; border: none; background: none; width: 100%; text-align: left;
}
.menu-item:hover { background: #dedede; }
.menu-item.active { background: #dce7f5; color: #0056e0; font-weight: 600; }
.menu-item-left { display: flex; align-items: center; gap: 10px; overflow: hidden; }
.menu-item-left i { width: 16px; text-align: center; color: #666; flex-shrink: 0; }
.menu-item.active .menu-item-left i { color: #0056e0; }
.menu-item-left span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.count-badge { font-size: 11px; color: #0056e0; font-weight: bold; flex-shrink: 0; }
.unread-dot { width: 6px; height: 6px; background: #ff4d4f; border-radius: 50%; flex-shrink: 0; display: inline-block; }
.sidebar-footer { margin-top: auto; padding: 8px 12px; font-size: 11px; color: #8a97a8; }

/* 中间邮件列表 */
.list-pane {
  width: 320px; flex: none; display: flex; flex-direction: column;
  border-right: 1px solid #d8dee4; background: #fff; min-height: 0;
}
.list-toolbar {
  height: 40px; padding: 0 12px; border-bottom: 1px solid #e8ecef; display: flex;
  align-items: center; gap: 12px; flex-shrink: 0; font-size: 12px; color: #555;
}
.list-toolbar label { display: flex; align-items: center; gap: 4px; cursor: pointer; user-select: none; }
.list-toolbar button {
  padding: 4px 10px; border: 1px solid #dcdfe6; border-radius: 4px; background: #f2f4f7;
  color: #333; cursor: pointer; display: flex; align-items: center; gap: 4px;
}
.list-toolbar button:hover { background: #e6e9f0; }
#messages { list-style: none; margin: 0; padding: 0; overflow: auto; flex: 1; }
#messages li { padding: 10px 14px; border-bottom: 1px solid #eef1f4; cursor: pointer; }
#messages li:hover { background: #f6f8fa; }
#messages li.active { background: #dce7f5; }
#messages li.unread .subject { font-weight: 700; color: #0056e0; }
#messages li.unread .subject::before { content: ""; display: inline-block; width: 6px; height: 6px; background: #ff4d4f; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
#messages li.flagged { background: #fff8e6; border-left: 3px solid #f0a020; padding-left: 9px; }
#messages li.flagged .subject::after { content: "📌"; margin-left: 6px; font-size: 12px; }
#messages li.hint { color: #8a97a8; cursor: default; text-align: center; }
#messages .subject { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #333; }
#messages .meta { color: #8a97a8; font-size: 11px; display: flex; gap: 8px; margin-top: 3px; }
#messages .meta .from { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge { font-size: 10px; color: #fff; background: #ff6b6b; border-radius: 3px; padding: 1px 5px; margin-left: 6px; }
#more { margin: 8px; flex: none; padding: 6px; border: 1px solid #dcdfe6; border-radius: 4px; background: #f2f4f7; cursor: pointer; }
#more:hover { background: #e6e9f0; }

/* 右侧阅读区 */
.reader { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; background: #fff; }
.reader-toolbar {
  height: 42px; padding: 0 16px; border-bottom: 1px solid #e8ecef; display: flex;
  align-items: center; justify-content: space-between; flex-shrink: 0; background: #fff;
}
.reader-toolbar .left { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #666; }
.reader-toolbar .left button {
  padding: 4px 10px; border: 1px solid #dcdfe6; border-radius: 4px; background: #f2f4f7;
  cursor: pointer; display: flex; align-items: center; gap: 4px; color: #333;
}
.reader-toolbar .left button:hover { background: #e6e9f0; }
.reader-toolbar .left button:disabled { opacity: .5; cursor: default; }
.reader-toolbar .right { font-size: 12px; color: #8a97a8; }

#readerHead { padding: 16px 24px; border-bottom: 1px solid #f0f0f0; flex-shrink: 0; }
#readerHead h2 { font-size: 16px; font-weight: bold; color: #111; margin-bottom: 10px; }
#readerHead .meta-row { display: flex; align-items: flex-start; gap: 12px; }
#readerHead .avatar-tag {
  width: 28px; height: 28px; background: #ff6b6b; color: #fff; border-radius: 4px;
  display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: bold; flex-shrink: 0;
}
#readerHead .meta-info { flex: 1; font-size: 12px; line-height: 1.7; }
#readerHead .sender-line { color: #333; }
#readerHead .sender-name { font-weight: bold; }
#readerHead .sender-email { color: #888; font-weight: normal; }
#readerHead .recipient-line { color: #888; }
#readerHead .kv { color: #888; }
#placeholder { color: #8a97a8; padding: 40px; text-align: center; }
#frame { flex: 1; border: none; width: 100%; background: #fff; min-height: 0; }
#attach { padding: 10px 24px; background: #fff; border-top: 1px solid #f0f0f0; font-size: 12px; flex-shrink: 0; }
#attach a { color: #1262d6; text-decoration: none; margin-right: 14px; display: inline-flex; align-items: center; gap: 4px; }
#attach a:hover { text-decoration: underline; }

/* banner：页面中央浮层提示 */
#banner {
  display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
  z-index: 200; margin: 0; padding: 10px 18px; border: 1px solid #e1e6ed;
  background: #fff; color: #333; font-size: 13px; border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.12); max-width: 80vw; text-align: center;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* 登录视图 */
#loginView {
  flex: 1; display: none; align-items: center; justify-content: center;
  background: #f4f6f9; padding: 24px;
}
#loginView.active { display: flex; }
#loginForm {
  width: 100%; max-width: 360px; background: #fff; border: 1px solid #e1e6ed;
  border-radius: 8px; padding: 32px 28px; box-shadow: 0 2px 10px rgba(0,0,0,0.04);
}
#loginForm h2 { margin: 0 0 8px; font-size: 18px; color: #1262d6; }
#loginForm .subtitle { font-size: 12px; color: #8a97a8; margin-bottom: 20px; }
#loginForm label { display: block; margin: 12px 0 4px; font-size: 13px; color: #555; }
#loginForm input {
  width: 100%; height: 34px; padding: 0 10px; border: 1px solid #d0d7de;
  border-radius: 6px; font: inherit; box-sizing: border-box; outline: none;
}
#loginForm input:focus { border-color: #0084ff; }
#loginForm button {
  margin-top: 20px; width: 100%; height: 36px; border: none; border-radius: 6px;
  background: linear-gradient(135deg, #2b80ff, #0056e0); color: #fff; cursor: pointer;
  font: inherit; font-weight: 500;
}
#loginForm button:hover:not(:disabled) { filter: brightness(1.05); }
#loginForm button:disabled { opacity: .5; cursor: default; }
#loginMsg { margin-top: 12px; font-size: 12px; color: #cf222e; min-height: 16px; }

/* AI 助理侧栏 */
.ai-panel {
  position: fixed; top: 0; right: 0; bottom: 0;
  width: 375px; display: flex; flex-direction: column;
  border-left: 1px solid #dce2e9; background: #f7f8fa; flex-shrink: 0; min-height: 0;
  z-index: 20; box-shadow: -4px 0 12px rgba(0,0,0,0.08);
}
.ai-panel-header {
  height: 44px; padding: 0 14px; border-bottom: 1px solid #e8ecef;
  display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; background: #fff;
}
.ai-panel-title { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; color: #1a1a1a; }
.ai-panel-close {
  border: none; background: none; cursor: pointer; color: #666; font-size: 13px;
  width: 24px; height: 24px; border-radius: 4px; display: flex; align-items: center; justify-content: center;
}
.ai-panel-close:hover { background: #eef1f5; color: #333; }
#aiFrame { flex: 1; border: none; width: 100%; min-height: 0; background: #f7f8fa; }

/* 智能分类 */
.plus-btn {
  border: none; background: none; color: #8a97a8; cursor: pointer;
  width: 18px; height: 18px; border-radius: 4px; display: inline-flex;
  align-items: center; justify-content: center; font-size: 11px;
}
.plus-btn:hover { background: #dce2e9; color: #0056e0; }
.menu-title { display: flex; align-items: center; justify-content: space-between; }
.title-toggle {
  display: flex; align-items: center; gap: 6px; cursor: pointer;
  flex: 1; user-select: none;
}
.title-toggle i { font-size: 10px; transition: transform .15s; width: 10px; }
#labelsGroup.expanded .title-toggle i { transform: rotate(90deg); }
.label-dot {
  width: 8px; height: 8px; border-radius: 50%; background: #0056e0;
  flex-shrink: 0; display: inline-block;
}
.menu-item .label-delete {
  border: none; background: none; color: #aaa; cursor: pointer;
  padding: 2px 4px; font-size: 12px; opacity: 0; transition: opacity .15s;
}
.menu-item:hover .label-delete { opacity: 1; }
.menu-item .label-delete:hover { color: #cf222e; }

dialog#labelModal {
  border: 1px solid #e1e6ed; border-radius: 8px; padding: 0;
  width: 360px; box-shadow: 0 4px 20px rgba(0,0,0,0.12); color: #333;
}
dialog#composeModal {
  border: 1px solid #e1e6ed; border-radius: 8px; padding: 0;
  width: 820px; max-width: 95vw; max-height: 92vh; overflow: auto;
  margin: auto; box-shadow: 0 4px 24px rgba(0,0,0,0.16); color: #333;
}
dialog#composeModal::backdrop { background: rgba(0,0,0,0.35); }
dialog#composeModal .compose-body { padding: 16px 20px; }
dialog#composeModal .compose-topbar {
  display: flex; justify-content: space-between; align-items: center;
  padding: 10px 16px; border-bottom: 1px solid #eee;
}
dialog#composeModal .compose-topbar .actions { display: flex; gap: 6px; }
dialog#composeModal .btn-c {
  padding: 4px 12px; border-radius: 3px; border: 1px solid #d9d9d9;
  background: #fff; cursor: pointer; font-size: 12px; color: #333;
}
dialog#composeModal .btn-c.primary { background: #3b7bff; color: #fff; border-color: #3b7bff; }
dialog#composeModal .btn-c.primary:hover { background: #2a69ea; }
dialog#composeModal .topbar-right { display: flex; gap: 14px; align-items: center; color: #666; font-size: 12px; }
dialog#composeModal .topbar-right span { cursor: pointer; }
dialog#composeModal .form-row {
  display: flex; align-items: center; padding: 6px 0; border-bottom: 1px solid #f0f0f0;
}
dialog#composeModal .form-label { width: 60px; color: #666; font-size: 12px; }
dialog#composeModal .form-input {
  flex: 1; border: none; outline: none; font-size: 13px; padding: 2px 0; background: transparent;
}
dialog#composeModal .placeholder-tip { color: #aaa; font-size: 11px; margin-left: 8px; }
dialog#composeModal .sub-tools {
  display: flex; align-items: center; gap: 14px; padding: 8px 0; color: #666; font-size: 12px;
}
dialog#composeModal .sub-tools .divider { width: 1px; height: 12px; background: #e8e8e8; }
dialog#composeModal .editor-container {
  border: 1px solid #e8e8e8; border-radius: 4px; margin-top: 6px; box-shadow: 0 1px 3px rgba(0,0,0,0.02);
}
dialog#composeModal .editor-toolbar {
  display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
  padding: 6px 10px; background: #fcfcfc; border-bottom: 1px solid #e8e8e8; font-size: 13px;
}
dialog#composeModal .tb-item {
  cursor: pointer; padding: 3px 5px; border-radius: 2px; display: inline-flex;
  align-items: center; gap: 2px; color: #555; user-select: none;
}
dialog#composeModal .tb-item:hover { background: #ececec; }
dialog#composeModal .tb-item.active { background: #dce7f5; color: #0056e0; }
dialog#composeModal .tb-select {
  border: 1px solid #d9d9d9; border-radius: 2px; padding: 2px 4px; background: #fff; font-size: 12px; outline: none;
}
dialog#composeModal .tool-btn {
  display: inline-flex; align-items: center; justify-content: center;
  height: 26px; min-width: 26px; padding: 0 5px; border-radius: 2px;
  cursor: pointer; color: #555; font-size: 13px; user-select: none;
}
dialog#composeModal .tool-btn:hover { background: #ececec; }
dialog#composeModal .tool-btn.active { background: #dcdcdc; }
dialog#composeModal .tool-select {
  height: 24px; border: 1px solid #d0d0d0; background: #fff;
  border-radius: 2px; padding: 0 4px; font-size: 12px; color: #333; outline: none; cursor: pointer;
}
dialog#composeModal .tb-divider { width: 1px; height: 14px; background: #e8e8e8; }
dialog#composeModal .editor-content {
  height: 280px; padding: 12px 15px; outline: none; overflow-y: auto; font-size: 13px; line-height: 1.6;
}
dialog#composeModal .compose-footer {
  display: flex; align-items: center; gap: 12px; margin-top: 10px; color: #666; font-size: 12px;
}
dialog#composeModal .compose-footer .from-info { color: #666; }
dialog#composeModal .compose-footer .from-info strong { color: #333; }
dialog#composeModal .compose-footer .footer-actions { margin-left: auto; display: flex; gap: 8px; }
dialog#composeModal #composeMsg { color: #cf222e; font-size: 12px; min-height: 14px; margin-top: 6px; }
}
dialog#labelModal::backdrop { background: rgba(0,0,0,0.3); }
dialog#labelModal form { padding: 20px 24px; }
dialog#labelModal h3 { margin: 0 0 12px; font-size: 16px; color: #1262d6; }
dialog#labelModal label { display: block; margin: 10px 0 4px; font-size: 13px; color: #555; }
dialog#labelModal input[type=text] {
  width: 100%; height: 32px; padding: 0 10px; border: 1px solid #d0d7de;
  border-radius: 6px; font: inherit; box-sizing: border-box; outline: none;
}
dialog#labelModal input[type=text]:focus { border-color: #0084ff; }
dialog#labelModal .color-row { display: flex; gap: 6px; margin-top: 4px; }
dialog#labelModal .color-swatch {
  width: 22px; height: 22px; border-radius: 50%; cursor: pointer;
  border: 2px solid transparent;
}
dialog#labelModal .color-swatch.active { border-color: #333; }
dialog#labelModal .actions { margin-top: 20px; display: flex; justify-content: flex-end; gap: 8px; }
dialog#labelModal button {
  padding: 6px 14px; border-radius: 6px; font: inherit; cursor: pointer; border: 1px solid #d0d7de;
}
dialog#labelModal button.btn-cancel { background: #f2f4f7; color: #555; }
dialog#labelModal button.btn-primary { background: linear-gradient(135deg, #2b80ff, #0056e0); color: #fff; border: none; }
#ctxMenu .ctx-item { padding: 8px 14px; cursor: pointer; display: flex; align-items: center; gap: 8px; color: #333; }
#ctxMenu .ctx-item:hover { background: #f0f6ff; }
#ctxMenu .ctx-item.ctx-danger { color: #d4351c; }
#ctxMenu .ctx-item.ctx-danger:hover { background: #fde8e6; }
#ctxMenu .ctx-item i { width: 14px; text-align: center; }
</style>
</head>
<body>

<div class="header">
  <div class="logo-area">
    <img src="${INBOX_ROUTE}/api/asset/email-logo.png" alt="logo" style="height:44px;width:auto;object-fit:contain;">
  </div>
  <div class="search-bar">
    <i class="fa-solid fa-magnifying-glass"></i>
    <input id="searchInput" type="text" placeholder="搜索邮件主题/发件人/收件人/正文" autocomplete="off">
  </div>
  <div class="user-area">
    <button id="aiAssistantBtn" type="button" title="AI 助理" style="border:none;background:none;cursor:pointer;padding:0;display:flex;align-items:center;gap:6px;font-size:13px;color:#333">
      <img src="${INBOX_ROUTE}/api/asset/emailAI.png" alt="AI助理" style="width:24px;height:24px;border-radius:50%">
      <span>AI助理</span>
    </button>
    <button id="logoutBtn" type="button" title="退出登录" style="border:1px solid #d0d7de;background:#fff;cursor:pointer;padding:4px 10px;font-size:12px;color:#555;border-radius:6px;display:flex;align-items:center;gap:4px;">
      <i class="fa-solid fa-right-from-bracket"></i> 退出登录
    </button>
  </div>
</div>

<div id="banner"></div>
<div id="fetchLoading" style="position:fixed; top:12px; left:50%; transform:translateX(-50%); background:#fff; border:1px solid #e1e6ed; border-radius:16px; padding:6px 14px; font-size:12px; color:#555; box-shadow:0 2px 8px rgba(0,0,0,0.08); display:none; z-index:50; gap:6px; align-items:center;">
  <i class="fa-solid fa-circle-notch fa-spin"></i><span>加载中…</span>
</div>
<div id="ctxMenu" style="position:fixed; display:none; background:#fff; border:1px solid #e1e6ed; border-radius:6px; box-shadow:0 4px 12px rgba(0,0,0,0.12); padding:4px 0; min-width:140px; z-index:100; font-size:13px;">
  <div class="ctx-item" data-act="reply"><i class="fa-solid fa-reply"></i> 回复邮件</div>
  <div class="ctx-item" data-act="todo"><i class="fa-solid fa-list-check"></i> 设为待办</div>
  <div class="ctx-item" data-act="seen"><i class="fa-solid fa-envelope-open"></i> <span class="ctx-seen-label">设为已读</span></div>
  <div class="ctx-item" data-act="pin"><i class="fa-solid fa-thumbtack"></i> <span class="ctx-pin-label">置顶邮件</span></div>
  <div class="ctx-item ctx-danger" data-act="delete"><i class="fa-solid fa-trash"></i> 删除邮件</div>
</div>

<div id="loginView">
  <form id="loginForm">
    <h2>登录 WeBank 邮箱</h2>
    <div class="subtitle">请输入邮箱地址与AD密码</div>
    <input type="hidden" id="loginProvider" value="webank">
    <label for="loginUser">邮箱地址</label>
    <input id="loginUser" type="email" autocomplete="username" placeholder="user@webank.com">
    <label for="loginPass">AD密码</label>
    <input id="loginPass" type="password" autocomplete="current-password" placeholder="邮箱AD密码">
    <button id="loginBtn" type="submit">登录</button>
    <div id="loginMsg"></div>
  </form>
</div>

<div class="main-container" id="mainView">
  <div class="sidebar">
    <div class="sidebar-action-row">
      <button class="btn-fetch" id="fetchBtn" type="button" title="收信">
        <i class="fa-solid fa-inbox"></i> 收信
      </button>
      <button class="btn-compose" id="composeBtn" type="button" title="写信">
        <i class="fa-solid fa-pen-to-square"></i> 写信
      </button>
    </div>
    <div class="menu-group">
      <div class="menu-title">文件夹</div>
      <nav id="folders"></nav>
    </div>
    <div class="menu-group" id="labelsGroup">
      <div class="menu-title">
        <span class="title-toggle" id="labelsToggle" title="展开/折叠">
          <i class="fa-solid fa-chevron-right"></i>
          智能分类
        </span>
        <button id="addLabelBtn" class="plus-btn" type="button" title="新建分类标签"><i class="fa-solid fa-plus"></i></button>
      </div>
      <nav id="labels" style="display:none"></nav>
    </div>
  </div>

  <div class="list-pane">
    <div class="list-toolbar">
      <label class="chk"><input type="checkbox" id="unreadOnly"> 只看未读</label>
      <span style="flex:1"></span>
    </div>
    <ul id="messages"></ul>
    <button id="more" type="button" style="display:none">加载更多</button>
  </div>

  <div class="reader">
    <div class="reader-toolbar">
      <div class="left">
        <span>邮件正文在沙箱内渲染，脚本一律禁用</span>
      </div>
      <div class="right" id="readerMeta"></div>
    </div>
    <div id="readerHead"><div id="placeholder"><i class="fa-regular fa-envelope-open" style="font-size:32px; color:#d0d7de"></i><div style="margin-top:8px">在左侧选择一封邮件阅读</div></div></div>
    <iframe id="frame" sandbox="" referrerpolicy="no-referrer" title="邮件正文"></iframe>
    <div id="attach" style="display:none"></div>
  </div>

  <aside id="aiPanel" class="ai-panel" style="display:none">
    <div class="ai-panel-header">
      <div class="ai-panel-title">
        <img src="${INBOX_ROUTE}/api/asset/emailAI.png" alt="AI" style="width:20px;height:20px;border-radius:50%">
        <span>AI 助理</span>
      </div>
    </div>
    <iframe id="aiFrame" src="${INBOX_ROUTE}/api/asset/assistant.html" title="AI 助理" referrerpolicy="no-referrer"></iframe>
  </aside>
</div>

<dialog id="labelModal">
  <form id="labelForm" method="dialog">
    <h3 id="labelModalTitle">新建分类标签</h3>
    <label for="labelName">标签名称</label>
    <input id="labelName" type="text" placeholder="例如：告警" maxlength="20">
    <label for="labelKeywords">关键词（逗号分隔，主题含任一关键词即归类）</label>
    <input id="labelKeywords" type="text" placeholder="例如：告警,监控,IMS">
    <label>颜色</label>
    <div class="color-row" id="labelColors"></div>
    <input id="labelId" type="hidden">
    <input id="labelColor" type="hidden">
    <div class="actions">
      <button type="button" class="btn-cancel" id="labelCancel">取消</button>
      <button type="submit" class="btn-primary" id="labelSave">保存</button>
    </div>
    <div id="labelMsg" style="margin-top:8px;font-size:12px;color:#cf222e;min-height:16px"></div>
  </form>
</dialog>

<dialog id="composeModal">
  <form id="composeForm" method="dialog">
    <div class="compose-topbar">
      <div class="actions">
        <button type="button" class="btn-c primary" id="composeSend"><i class="fa-solid fa-paper-plane"></i> 发送</button>
        <button type="button" class="btn-c" id="composePreview">预览</button>
        <button type="button" class="btn-c" id="composeDraft">存草稿</button>
        <button type="button" class="btn-c" id="composeCancel">取消</button>
      </div>
      <div class="topbar-right">
        <span id="composeCcToggle">抄送</span>
      </div>
    </div>
    <div class="compose-body">
      <div class="form-row">
        <span class="form-label">收件人：</span>
        <input id="composeTo" type="text" class="form-input" placeholder="发给多人时地址请以分号或逗号隔开">
        <span class="placeholder-tip">发给多人时地址请以分号或逗号隔开</span>
      </div>
      <div class="form-row" id="composeCcRow" style="display:none">
        <span class="form-label">抄 送：</span>
        <input id="composeCc" type="text" class="form-input" placeholder="抄送地址">
      </div>
      <div class="form-row">
        <span class="form-label">主 题：</span>
        <input id="composeSubject" type="text" class="form-input" placeholder="邮件主题">
      </div>
      <div class="sub-tools">
        <span class="tb-item" id="composeAttachBtn" style="cursor:pointer;color:#3b7bff">📎 添加附件</span>
        <input type="file" id="composeAttachInput" multiple style="display:none">
        <span class="divider"></span>
        <input id="composeAttachments" type="text" class="form-input" placeholder="附件路径，多个用逗号分隔" style="flex:1" readonly>
      </div>
      <div class="editor-container">
        <div class="editor-toolbar">
          <span class="tool-btn" data-cmd="undo" title="撤销">↶</span>
          <span class="tool-btn" data-cmd="redo" title="重做">↷</span>
          <span class="tool-btn" data-cmd="removeFormat" title="清除格式">🧹</span>
          <span class="tb-divider"></span>
          <select class="tool-select" id="composeFontName" title="字体">
            <option value="">默认字体</option>
            <option value="Arial">Arial</option>
            <option value="PingFang SC">PingFang SC</option>
            <option value="Microsoft YaHei">Microsoft YaHei</option>
            <option value="SimSun">SimSun</option>
            <option value="Helvetica">Helvetica</option>
            <option value="Georgia">Georgia</option>
          </select>
          <select class="tool-select" id="composeFontSize" title="字号">
            <option value="">字号</option>
            <option value="2">小</option>
            <option value="3">正常</option>
            <option value="4">中</option>
            <option value="5">大</option>
            <option value="6">特大</option>
          </select>
          <span class="tb-divider"></span>
          <span class="tool-btn" data-cmd="bold" title="加粗" style="font-weight:bold">B</span>
          <span class="tool-btn" data-cmd="italic" title="斜体" style="font-style:italic;font-family:Georgia,serif">I</span>
          <span class="tool-btn" data-cmd="underline" title="下划线" style="text-decoration:underline">U</span>
          <span class="tool-btn" data-cmd="strikeThrough" title="删除线" style="text-decoration:line-through">S</span>
          <span class="tb-divider"></span>
          <input type="color" class="tool-select" id="composeForeColor" title="文字颜色" style="width:24px;height:24px;padding:0;cursor:pointer;border:1px solid #d0d0d0;border-radius:2px">
          <span class="tb-divider"></span>
          <span class="tool-btn" data-cmd="justifyLeft" title="左对齐">⬅</span>
          <span class="tool-btn" data-cmd="justifyCenter" title="居中">↔</span>
          <span class="tool-btn" data-cmd="justifyRight" title="右对齐">➡</span>
          <span class="tb-divider"></span>
          <span class="tool-btn" data-cmd="insertUnorderedList" title="无序列表">•</span>
          <span class="tool-btn" data-cmd="insertOrderedList" title="有序列表">1.</span>
          <span class="tb-divider"></span>
          <span class="tool-btn" data-cmd="outdent" title="减少缩进">⇤</span>
          <span class="tool-btn" data-cmd="indent" title="增加缩进">⇥</span>
        </div>
        <div id="composeEditor" class="editor-content" contenteditable="true"></div>
      </div>
      <div class="compose-footer">
        <div class="from-info">发件人：<strong id="composeFrom">加载中…</strong></div>
        <div class="footer-actions">
          <button type="button" class="btn-c primary" id="composeSend2"><i class="fa-solid fa-paper-plane"></i> 发送</button>
          <button type="button" class="btn-c" id="composeCancel2">取消</button>
        </div>
      </div>
      <div id="composeMsg"></div>
    </div>
  </form>
</dialog>

<script>
(function () {
  'use strict';
  var BASE = '${INBOX_ROUTE}';
  var state = { account: '', folder: '', view: 'folder', labelId: '', unreadOnly: false, offset: 0, limit: 20, uid: null, imagesAllowed: true };
  var LABEL_COLORS = ['#0056e0', '#cf222e', '#1a7f37', '#9333ea', '#d97706', '#0891b2', '#db2777', '#4b5563'];

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
  function folderIcon(f) {
    var s = f.specialUse || '';
    if (s.indexOf('Inbox') >= 0) return 'fa-regular fa-folder-open';
    if (s.indexOf('Sent') >= 0) return 'fa-regular fa-paper-plane';
    if (s.indexOf('Drafts') >= 0) return 'fa-regular fa-file-lines';
    if (s.indexOf('Trash') >= 0) return 'fa-regular fa-trash-can';
    if (s.indexOf('Junk') >= 0 || s.indexOf('Spam') >= 0) return 'fa-regular fa-circle-xmark';
    if (s.indexOf('Archive') >= 0) return 'fa-regular fa-box-archive';
    return 'fa-regular fa-folder';
  }
  function avatarLetter(text) {
    var t = String(text || '?').trim();
    return t.charAt(0).toUpperCase();
  }
  // webank/Coremail 把中文姓名塞进 local part：lakerli(李可)@webank.com。
  // 这种格式可能出现在 name 字段（"lakerli(李可)"）或 address 字段里。
  // 两处都提取括号内中文作为显示名，剩余 local part 拼回 address。
  function extractChinese(text) {
    if (!text) return '';
    var m = String(text).match(/\\(([^)]+)\\)/);
    return m ? m[1].trim() : '';
  }
  function parseAddr(raw) {
    var addr = raw || {};
    var a = String(addr.address || '').trim();
    var rawName = String(addr.name || '').trim();
    var name = '';
    if (rawName) {
      var n = extractChinese(rawName);
      name = n || rawName;
    }
    if (!name && a) {
      var inAddr = extractChinese(a);
      if (inAddr) {
        name = inAddr;
        a = a.replace(/\\([^)]+\\)/, '');
      }
    }
    return { name: name, address: a };
  }
  var FOLDER_LABELS = {
    'INBOX': '收件箱',
    'Sent': '已发送', 'Sent Messages': '已发送', '已发送': '已发送',
    'Drafts': '草稿箱', 'Draft': '草稿箱', '草稿': '草稿箱', '草稿箱': '草稿箱',
    'Trash': '已删除', 'Deleted': '已删除', 'Deleted Messages': '已删除', '已删除': '已删除',
    'Junk': '垃圾邮件', 'Spam': '垃圾邮件', '垃圾邮件': '垃圾邮件', 'Bulk Mail': '垃圾邮件',
    'Archive': '归档', 'All Mail': '全部邮件',
    'Notes': '备忘录', 'Flagged': '星标',
  };
  function folderLabel(f) {
    var key = String(f.name || f.path || '').trim();
    if (FOLDER_LABELS[key]) return FOLDER_LABELS[key];
    if (key.toUpperCase() === 'INBOX') return '收件箱';
    return f.name || f.path;
  }
  function qs(params) {
    var u = new URLSearchParams();
    Object.keys(params).forEach(function (k) {
      var v = params[k];
      if (v === '' || v === null || v === undefined || v === false) return;
      u.set(k, v === true ? '1' : String(v));
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
  var bannerTimer = null;
  function showBanner(msg) {
    var b = document.getElementById('banner');
    b.textContent = msg;
    b.style.display = 'block';
    if (bannerTimer) clearTimeout(bannerTimer);
    bannerTimer = setTimeout(function () {
      b.style.display = 'none';
      bannerTimer = null;
    }, 3000);
  }

  function loadFolders() {
    return api('/api/folders', { account: state.account }).then(function (value) {
      var accounts = value.accounts || [];
      if (!state.account && accounts.length > 0) state.account = accounts[0];
      var folders = (value.folders || []).slice();
      folders.sort(function (a, b) {
        var av = /病毒|Virus|Infected/i.test(a.path) ? 1 : 0;
        var bv = /病毒|Virus|Infected/i.test(b.path) ? 1 : 0;
        return av - bv;
      });
      var known = folders.some(function (f) { return f.path === state.folder; });
      if (!known) {
        var inbox = folders.filter(function (f) {
          return f.specialUse === '\\\\Inbox' || String(f.path).toUpperCase() === 'INBOX';
        })[0];
        state.folder = (inbox || folders[0] || { path: '' }).path;
      }
      var nav = document.getElementById('folders');
      nav.innerHTML = '';
      var trashIdx = -1;
      folders.forEach(function (f, i) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'menu-item';
        btn.dataset.path = f.path;
        btn.title = f.path + (f.specialUse ? ' [' + f.specialUse + ']' : '') + (f.subscribed ? '' : '（未订阅）');
        if (f.path === state.folder) btn.classList.add('active');
        var left = document.createElement('div');
        left.className = 'menu-item-left';
        var icon = document.createElement('i');
        icon.className = folderIcon(f);
        var label = document.createElement('span');
        label.textContent = folderLabel(f);
        left.appendChild(icon);
        left.appendChild(label);
        btn.appendChild(left);
        var unread = (typeof f.unread === 'number') ? f.unread : -1;
        if (unread > 0) {
          var c = document.createElement('span');
          c.className = 'count-badge';
          c.textContent = unread;
          c.title = '未读 ' + unread;
          btn.appendChild(c);
        }
        btn.onclick = function () {
          if (state.view === 'folder' && state.folder === f.path) return;
          state.view = 'folder';
          state.folder = f.path;
          state.uid = null;
          state.offset = 0;
          markActiveFolder();
          markActiveLabel();
          loadList();
        };
        nav.appendChild(btn);
        if (trashIdx < 0 && (f.specialUse === '\\\\Trash' || /已删除|Trash|Deleted/i.test(f.path))) trashIdx = i;
      });
      var todoBtn = document.createElement('button');
      todoBtn.type = 'button';
      todoBtn.id = 'todoBtn';
      todoBtn.className = 'menu-item';
      var tLeft = document.createElement('div');
      tLeft.className = 'menu-item-left';
      var tIcon = document.createElement('i');
      tIcon.className = 'fa-solid fa-list-check';
      tIcon.style.cssText = 'width:16px;text-align:center;color:#666;';
      var tLabel = document.createElement('span');
      tLabel.textContent = '待办邮件';
      tLeft.appendChild(tIcon);
      tLeft.appendChild(tLabel);
      todoBtn.appendChild(tLeft);
      var tCount = document.createElement('span');
      tCount.id = 'todoCount';
      tCount.className = 'count-badge';
      tCount.style.display = 'none';
      todoBtn.appendChild(tCount);
      if (state.view === 'todo') todoBtn.classList.add('active');
      todoBtn.onclick = function () {
        if (state.view === 'todo') return;
        state.view = 'todo';
        state.uid = null;
        markActiveFolder();
        markActiveLabel();
        openTodoView();
      };
      var inserted = false;
      if (trashIdx >= 0) {
        var after = nav.children[trashIdx + 1];
        if (after) nav.insertBefore(todoBtn, after);
        else nav.appendChild(todoBtn);
        inserted = true;
      }
      if (!inserted) nav.appendChild(todoBtn);
    });
  }
  function markActiveFolder() {
    var btns = document.querySelectorAll('#folders .menu-item');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', state.view === 'folder' && btns[i].dataset.path === state.folder);
    }
    var todoBtn = document.getElementById('todoBtn');
    if (todoBtn) todoBtn.classList.toggle('active', state.view === 'todo');
  }
  function markActiveLabel() {
    var btns = document.querySelectorAll('#labels .menu-item');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', state.view === 'label' && btns[i].dataset.id === state.labelId);
    }
    var todoBtn = document.getElementById('todoBtn');
    if (todoBtn) todoBtn.classList.toggle('active', state.view === 'todo');
  }

  function loadTodoCount() {
    return fetch(BASE + '/api/todos').then(function (res) {
      return res.json().catch(function () { return null; });
    }).then(function (d) {
      var todos = (d && d.ok && Array.isArray(d.value)) ? d.value : [];
      var badge = document.getElementById('todoCount');
      if (todos.length > 0) {
        badge.textContent = todos.length;
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
      if (state.view === 'todo') loadTodoList(todos, state.unreadOnly);
    }).catch(function () { /* best-effort */ });
  }
  function openTodoView() {
    state.labelId = '';
    state.offset = 0;
    var listEl = document.getElementById('messages');
    listEl.innerHTML = '';
    var loading = document.createElement('li');
    loading.className = 'hint';
    loading.textContent = '正在从邮箱同步待办邮件…';
    listEl.appendChild(loading);
    var more = document.getElementById('more');
    if (more) more.style.display = 'none';
    fetch(BASE + '/api/todos/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: state.account || 'default', limit: 200 }),
    }).then(function (res) { return res.json().catch(function () { return null; }); }).then(function () {
      loadTodoList(null, state.unreadOnly);
      loadTodoCount();
    }).catch(function () {
      loadTodoList(null, state.unreadOnly);
      loadTodoCount();
    });
  }
  function loadTodoList(todos, onlyUnread) {
    var listEl = document.getElementById('messages');
    listEl.innerHTML = '';
    if (!todos) {
      fetch(BASE + '/api/todos').then(function (res) { return res.json().catch(function () { return null; }); }).then(function (d) {
        loadTodoList((d && d.ok && Array.isArray(d.value)) ? d.value : [], onlyUnread);
      });
      return;
    }
    var filtered = onlyUnread ? todos.filter(function (t) { return !t.seen; }) : todos;
    filtered.forEach(function (t) {
      var li = document.createElement('li');
      li.dataset.uid = String(t.uid);
      li.dataset.folder = t.folder;
      li.dataset.todoId = t.id;
      li.dataset.subject = t.subject || '(无主题)';
      li.dataset.from = t.from || '';
      li.dataset.date = t.date || '';
      var subject = document.createElement('span');
      subject.className = 'subject';
      subject.textContent = t.subject || '(无主题)';
      li.appendChild(subject);
      var meta = document.createElement('div');
      meta.className = 'meta';
      var from = document.createElement('span');
      from.className = 'from';
      from.textContent = t.from || '(未知)';
      var date = document.createElement('span');
      date.textContent = fmtDate(t.date);
      meta.appendChild(from);
      meta.appendChild(date);
      li.appendChild(meta);
      li.onclick = function () { openMessage(t.uid, t.folder); };
      li.oncontextmenu = function (e) {
        e.preventDefault();
        var menu = document.getElementById('ctxMenu');
        menu.querySelector('.ctx-seen-label').textContent = '移除待办';
        menu.querySelector('.ctx-pin-label').textContent = '置顶邮件';
        menu.dataset.uid = String(t.uid);
        menu.dataset.folder = t.folder;
        menu.dataset.todoId = t.id;
        menu.dataset.subject = t.subject || '';
        menu.dataset.from = t.from || '';
        menu.dataset.date = t.date || '';
        menu.dataset.seen = '1';
        menu.dataset.flagged = '0';
        menu.dataset.isTodo = '1';
        menu.style.display = 'block';
        var x = e.clientX, y = e.clientY;
        var rect = menu.getBoundingClientRect();
        if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
        if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
      };
      listEl.appendChild(li);
    });
    if (filtered.length === 0) {
      var hint = document.createElement('li');
      hint.className = 'hint';
      hint.textContent = todos.length === 0 ? '待办箱为空' : '没有未读待办邮件';
      listEl.appendChild(hint);
    }
    var more = document.getElementById('more');
    if (more) more.style.display = 'none';
  }

  function loadLabels() {
    return fetch(BASE + '/api/labels').then(function (res) {
      return res.json().catch(function () { return null; });
    }).then(function (data) {
      var labels = (data && data.ok && data.value) ? data.value : [];
      var nav = document.getElementById('labels');
      nav.innerHTML = '';
      labels.forEach(function (l) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'menu-item';
        btn.dataset.id = l.id;
        if (state.view === 'label' && state.labelId === l.id) btn.classList.add('active');
        var left = document.createElement('div');
        left.className = 'menu-item-left';
        var icon = document.createElement('i');
        icon.className = 'fa-regular fa-folder';
        icon.style.cssText = 'width:16px;text-align:center;color:#666;';
        var span = document.createElement('span');
        span.textContent = l.name;
        left.appendChild(icon);
        left.appendChild(span);
        btn.appendChild(left);
        var right = document.createElement('div');
        right.style.cssText = 'display:flex;align-items:center;gap:6px;';
        var dot = document.createElement('span');
        dot.className = 'label-dot';
        dot.style.background = l.color || LABEL_COLORS[0];
        right.appendChild(dot);
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'label-delete';
        del.title = '删除标签';
        del.innerHTML = '<i class="fa-solid fa-trash"></i>';
        right.appendChild(del);
        btn.appendChild(right);
        del.onclick = function (ev) {
          ev.stopPropagation();
          if (!confirm('删除标签 "' + l.name + '"？')) return;
          fetch(BASE + '/api/labels/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: l.id }),
          }).then(function (res) {
            return res.json().catch(function () { return null; });
          }).then(function (d) {
            if (!res.ok || !d || !d.ok) throw new Error((d && d.error && d.error.message) || ('HTTP ' + res.status));
            if (state.view === 'label' && state.labelId === l.id) {
              state.view = 'folder';
              state.labelId = '';
              state.uid = null;
              state.offset = 0;
              loadList();
            }
            loadLabels();
          }).catch(function (err) { showBanner(err.message); });
        };
        btn.onclick = function () {
          if (state.view === 'label' && state.labelId === l.id) return;
          state.view = 'label';
          state.labelId = l.id;
          state.uid = null;
          state.offset = 0;
          markActiveFolder();
          markActiveLabel();
          loadList();
        };
        nav.appendChild(btn);
      });
    }).catch(function (err) { showBanner(err.message); });
  }

  function openLabelModal(label) {
    var modal = document.getElementById('labelModal');
    var title = document.getElementById('labelModalTitle');
    var idInput = document.getElementById('labelId');
    var nameInput = document.getElementById('labelName');
    var kwInput = document.getElementById('labelKeywords');
    var colorInput = document.getElementById('labelColor');
    var msg = document.getElementById('labelMsg');
    msg.textContent = '';
    if (label) {
      title.textContent = '编辑分类标签';
      idInput.value = label.id;
      nameInput.value = label.name;
      kwInput.value = (label.keywords || []).join(',');
      colorInput.value = label.color || LABEL_COLORS[0];
    } else {
      title.textContent = '新建分类标签';
      idInput.value = '';
      nameInput.value = '';
      kwInput.value = '';
      colorInput.value = LABEL_COLORS[0];
    }
    var colors = document.getElementById('labelColors');
    colors.innerHTML = '';
    LABEL_COLORS.forEach(function (c) {
      var sw = document.createElement('div');
      sw.className = 'color-swatch' + (colorInput.value === c ? ' active' : '');
      sw.style.background = c;
      sw.onclick = function () {
        colorInput.value = c;
        var children = colors.children;
        for (var i = 0; i < children.length; i++) children[i].classList.remove('active');
        sw.classList.add('active');
      };
      colors.appendChild(sw);
    });
    modal.showModal();
    nameInput.focus();
  }

  function rowEl(m) {
    var li = document.createElement('li');
    li.dataset.uid = String(m.uid);
    var effFolder = m.folder || state.folder;
    li.dataset.folder = effFolder;
    li.dataset.seen = m.seen ? '1' : '0';
    li.dataset.flagged = m.flagged ? '1' : '0';
    li.dataset.subject = m.subject || '(无主题)';
    li.dataset.from = (m.from || []).map(function (a) {
      var p = parseAddr(a);
      return p.address || p.name;
    }).filter(Boolean).join(',');
    li.dataset.date = m.date || '';
    if (!m.seen) li.classList.add('unread');
    if (m.flagged) li.classList.add('flagged');
    if (m.uid === state.uid) li.classList.add('active');
    var subject = document.createElement('span');
    subject.className = 'subject';
    subject.textContent = m.subject || '(无主题)';
    if (m.hasAttachments) {
      var badge = document.createElement('span');
      badge.className = 'badge';
      badge.innerHTML = '<i class="fa-solid fa-paperclip"></i>';
      subject.appendChild(badge);
    }
    li.appendChild(subject);
    var meta = document.createElement('div');
    meta.className = 'meta';
    var from = document.createElement('span');
    from.className = 'from';
    from.textContent = (m.from || []).map(function (a) {
      var p = parseAddr(a);
      return p.name || p.address;
    }).filter(Boolean).join(', ') || '(未知)';
    var date = document.createElement('span');
    date.textContent = fmtDate(m.date);
    meta.appendChild(from);
    meta.appendChild(date);
    li.appendChild(meta);
    li.onclick = function () { openMessage(m.uid, effFolder); };
    li.oncontextmenu = function (e) {
      e.preventDefault();
      openCtxMenu(e, li);
    };
    return li;
  }

  function openCtxMenu(e, li) {
    var menu = document.getElementById('ctxMenu');
    var seen = li.dataset.seen === '1';
    var flagged = li.dataset.flagged === '1';
    menu.querySelector('.ctx-seen-label').textContent = seen ? '设为未读' : '设为已读';
    menu.querySelector('.ctx-pin-label').textContent = flagged ? '取消置顶' : '置顶邮件';
    menu.dataset.uid = li.dataset.uid;
    menu.dataset.folder = li.dataset.folder;
    menu.dataset.seen = li.dataset.seen;
    menu.dataset.flagged = li.dataset.flagged;
    menu.dataset.subject = li.dataset.subject;
    menu.dataset.from = li.dataset.from;
    menu.dataset.date = li.dataset.date;
    menu.style.display = 'block';
    var x = e.clientX, y = e.clientY;
    var rect = menu.getBoundingClientRect();
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  }
  function closeCtxMenu() {
    var menu = document.getElementById('ctxMenu');
    if (menu) menu.style.display = 'none';
  }
  document.addEventListener('click', function () { closeCtxMenu(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeCtxMenu(); });

  function ctxAction(act) {
    var menu = document.getElementById('ctxMenu');
    var uid = Number(menu.dataset.uid);
    var folder = menu.dataset.folder;
    var seen = menu.dataset.seen === '1';
    var flagged = menu.dataset.flagged === '1';
    var subject = menu.dataset.subject;
    var from = menu.dataset.from;
    var date = menu.dataset.date;
    var isTodo = menu.dataset.isTodo === '1';
    var todoId = menu.dataset.todoId;
    closeCtxMenu();
    if (act === 'reply') {
      startReply({ to: from, subject: subject });
      return;
    }
    if (isTodo && act === 'seen') {
      fetch(BASE + '/api/todos/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: todoId }),
      }).then(function (res) { return res.json().catch(function () { return null; }); }).then(function (d) {
        if (d && d.ok) { showBanner('已移除待办'); loadTodoCount(); }
        else showBanner((d && d.error && d.error.message) || '移除失败');
      });
      return;
    }
    if (act === 'todo') {
      if (isTodo) {
        fetch(BASE + '/api/todos/delete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: todoId }),
        }).then(function (res) { return res.json().catch(function () { return null; }); }).then(function (d) {
          if (d && d.ok) { showBanner('已移除待办'); loadTodoCount(); }
          else showBanner((d && d.error && d.error.message) || '移除失败');
        });
        if (!flagged) {
          fetch(BASE + '/api/pin', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account: state.account, folder: folder, uid: uid, on: false }),
          });
        }
      } else {
        fetch(BASE + '/api/todos', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account: state.account, folder: folder, uid: uid, subject: subject, from: from, date: date, seen: seen }),
        }).then(function (res) { return res.json().catch(function () { return null; }); }).then(function (d) {
          if (d && d.ok) { showBanner('已加入待办'); loadTodoCount(); }
          else showBanner((d && d.error && d.error.message) || '加入待办失败');
        });
        if (!flagged) {
          fetch(BASE + '/api/pin', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account: state.account, folder: folder, uid: uid, on: true }),
          }).then(function (res) { return res.json().catch(function () { return null; }); }).then(function (d) {
            if (d && d.ok) {
              var li = document.querySelector('#messages li[data-uid="' + uid + '"]');
              if (li) { li.classList.add('flagged'); li.dataset.flagged = '1'; }
            }
          });
        }
      }
      return;
    }
    if (act === 'seen') {
      fetch(BASE + '/api/toggle-seen', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: state.account, folder: folder, uid: uid, on: !seen }),
      }).then(function (res) { return res.json().catch(function () { return null; }); }).then(function (d) {
        if (d && d.ok) {
          var li = document.querySelector('#messages li[data-uid="' + uid + '"]');
          if (li) {
            li.classList.toggle('unread', seen);
            li.dataset.seen = seen ? '0' : '1';
          }
        } else showBanner((d && d.error && d.error.message) || '切换失败');
      });
      return;
    }
    if (act === 'pin') {
      fetch(BASE + '/api/pin', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: state.account, folder: folder, uid: uid, on: !flagged }),
      }).then(function (res) { return res.json().catch(function () { return null; }); }).then(function (d) {
        if (d && d.ok) {
          showBanner(flagged ? '已取消置顶' : '已置顶');
          if (state.view === 'folder') {
            loadList();
          } else if (state.view === 'todo') {
            loadTodoList(null, state.unreadOnly);
          }
        } else showBanner((d && d.error && d.error.message) || '置顶失败');
      });
      return;
    }
    if (act === 'delete') {
      if (!confirm('确定删除这封邮件？（移动到已删除文件夹）')) return;
      fetch(BASE + '/api/move', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: state.account, folder: folder, uid: uid, target: '已删除' }),
      }).then(function (res) { return res.json().catch(function () { return null; }); }).then(function (d) {
        if (d && d.ok) {
          var li = document.querySelector('#messages li[data-uid="' + uid + '"]');
          if (li) li.remove();
          showBanner('已删除');
        } else showBanner((d && d.error && d.error.message) || '删除失败');
      });
      return;
    }
  }
  document.querySelectorAll('#ctxMenu .ctx-item').forEach(function (item) {
    item.onclick = function (e) {
      e.stopPropagation();
      ctxAction(item.dataset.act);
    };
  });

  function loadList() {
    var listEl = document.getElementById('messages');
    if (state.offset === 0) listEl.innerHTML = '';
    var params;
    if (state.view === 'label') {
      params = { account: state.account, label: state.labelId, limit: state.limit };
    } else {
      params = { account: state.account, folder: state.folder, limit: state.limit, offset: state.offset, unreadOnly: state.unreadOnly };
    }
    return api('/api/messages', params).then(function (value) {
      (value.messages || []).forEach(function (m) { listEl.appendChild(rowEl(m)); });
      var shown = listEl.children.length;
      var more = document.getElementById('more');
      more.style.display = (state.view === 'label' || shown >= value.count) ? 'none' : '';
      if (shown === 0) {
        var hint = document.createElement('li');
        hint.className = 'hint';
        hint.textContent = value.count === 0 ? (state.view === 'label' ? '此标签没有匹配邮件' : '此文件夹没有邮件') : '没有更多邮件';
        listEl.appendChild(hint);
      }
    }).catch(function (err) { showBanner(err.message); });
  }
  function silentRefresh() {
    if (state.offset !== 0) return Promise.resolve();
    var params = state.view === 'label'
      ? { account: state.account, label: state.labelId, limit: state.limit }
      : { account: state.account, folder: state.folder, limit: state.limit, unreadOnly: state.unreadOnly };
    return api('/api/messages', params).then(function (value) {
      var listEl = document.getElementById('messages');
      var existing = {};
      for (var i = 0; i < listEl.children.length; i++) {
        var li = listEl.children[i];
        if (li.dataset.uid) existing[li.dataset.uid] = li;
      }
      var seen = {};
      var fresh = value.messages || [];
      var prependBucket = [];
      fresh.forEach(function (m) {
        var key = String(m.uid);
        seen[key] = true;
        var old = existing[key];
        if (old) {
          old.classList.toggle('unread', !m.seen);
          old.classList.toggle('active', m.uid === state.uid);
          existing[key] = null;
        } else {
          prependBucket.push(rowEl(m));
        }
      });
      for (var k in existing) {
        if (existing[k] && existing[k].parentNode) existing[k].parentNode.removeChild(existing[k]);
      }
      if (prependBucket.length) {
        var hint = listEl.querySelector('.hint');
        if (hint) hint.remove();
        for (var j = prependBucket.length - 1; j >= 0; j--) {
          listEl.insertBefore(prependBucket[j], listEl.firstChild);
        }
      }
      var shown = listEl.children.length;
      var more = document.getElementById('more');
      more.style.display = (state.view === 'label' || shown >= value.count) ? 'none' : '';
      if (shown === 0) {
        var h = document.createElement('li');
        h.className = 'hint';
        h.textContent = value.count === 0 ? (state.view === 'label' ? '此标签没有匹配邮件' : '此文件夹没有邮件') : '没有更多邮件';
        listEl.appendChild(h);
      }
    }).catch(function () { /* 静默刷新不弹错 */ });
  }

  function loadFrame(folder) {
    var frame = document.getElementById('frame');
    frame.src = BASE + '/api/message.html' + qs({
      account: state.account, folder: folder, uid: state.uid, images: state.imagesAllowed,
    });
  }

  function openMessage(uid, folder) {
    var effFolder = folder || state.folder;
    state.uid = uid;
    state.imagesAllowed = true;
    var items = document.getElementById('messages').children;
    var flipped = false;
    for (var i = 0; i < items.length; i++) {
      var li = items[i];
      var match = Number(li.dataset.uid) === uid;
      li.classList.toggle('active', match);
      if (match && li.classList.contains('unread')) {
        li.classList.remove('unread');
        flipped = true;
      }
    }
    if (flipped) {
      fetch(BASE + '/api/mark-seen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: state.account, folder: effFolder, uid: uid }),
      }).catch(function () { /* best-effort; UI already updated */ });
    }
    var head = document.getElementById('readerHead');
    head.innerHTML = '<div id="placeholder">加载中…</div>';
    api('/api/message', { account: state.account, folder: effFolder, uid: uid }).then(function (v) {
      var fromParsed = parseAddr((v.from || [])[0]);
      var fromName = fromParsed.name || fromParsed.address || '(未知)';
      var to = (v.to || []).map(function (a) {
        var p = parseAddr(a);
        return p.name ? p.name + ' <' + p.address + '>' : p.address;
      }).join(', ');
      var cc = (v.cc || []).map(function (a) {
        var p = parseAddr(a);
        return p.name ? p.name + ' <' + p.address + '>' : p.address;
      }).join(', ');
      document.getElementById('readerMeta').textContent = fmtDate(v.date);
      head.innerHTML =
        '<h2>' + esc(v.subject || '(无主题)') + '</h2>' +
        '<div class="meta-row">' +
          '<div class="avatar-tag">' + esc(avatarLetter(fromName)) + '</div>' +
          '<div class="meta-info">' +
            '<div class="sender-line"><span class="sender-name">' + esc(fromName) + '</span> <span class="sender-email">&lt;' + esc(fromParsed.address) + '&gt;</span></div>' +
            '<div class="recipient-line">收件人：' + esc(to) + (cc ? ' · 抄送：' + esc(cc) : '') + '</div>' +
          '</div>' +
        '</div>';
      var attach = document.getElementById('attach');
      attach.innerHTML = '';
      (v.attachments || []).forEach(function (a, i) {
        var link = document.createElement('a');
        link.href = BASE + '/api/attachment' + qs({ account: state.account, folder: effFolder, uid: uid, index: i });
        link.innerHTML = '<i class="fa-solid fa-file"></i> ' + esc(a.filename) + '（' + fmtSize(a.size) + '）';
        attach.appendChild(link);
      });
      attach.style.display = (v.attachments && v.attachments.length > 0) ? '' : 'none';
      loadFrame(effFolder);
    }).catch(function (err) {
      head.innerHTML = '<div id="placeholder">' + esc(err.message) + '</div>';
    });
  }

  document.getElementById('unreadOnly').onchange = function () {
    if (state.view === 'label') { this.checked = false; return; }
    state.unreadOnly = this.checked;
    state.offset = 0;
    if (state.view === 'todo') {
      fetch(BASE + '/api/todos').then(function (res) { return res.json().catch(function () { return null; }); }).then(function (d) {
        loadTodoList((d && d.ok && Array.isArray(d.value)) ? d.value : [], state.unreadOnly);
      });
      return;
    }
    loadList();
  };
  var logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.onclick = function () {
      if (!confirm('退出登录？将清空已保存的AD密码并回到登录页。')) return;
      fetch(BASE + '/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
        .then(function (res) { return res.json().catch(function () { return null; }); })
        .then(function (d) {
          if (d && d.ok) {
            document.getElementById('loginPass').value = '';
            var u = document.getElementById('loginUser');
            if (u && !u.value) u.value = '';
            showLogin();
          } else {
            showBanner((d && d.error && d.error.message) || '退出失败');
          }
        }).catch(function () { showBanner('退出失败'); });
    };
  }
  var searchInput = document.getElementById('searchInput');
  var searchTimer = null;
  if (searchInput) {
    searchInput.onkeydown = function (e) {
      if (e.key !== 'Enter') return;
      var q = this.value.trim();
      if (!q) {
        if (state.view === 'search') {
          state.view = 'folder';
          state.offset = 0;
          loadList();
        }
        return;
      }
      if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
      state.view = 'search';
      state.searchQ = q;
      state.offset = 0;
      markActiveFolder();
      markActiveLabel();
      var listEl = document.getElementById('messages');
      listEl.innerHTML = '';
      var loading = document.createElement('li');
      loading.className = 'hint';
      loading.textContent = '搜索 "' + q + '" 中…';
      listEl.appendChild(loading);
      var more = document.getElementById('more');
      if (more) more.style.display = 'none';
      api('/api/search', { account: state.account, folder: state.folder, q: q, limit: 50 }).then(function (value) {
        listEl.innerHTML = '';
        var msgs = value.messages || [];
        if (msgs.length === 0) {
          var hint = document.createElement('li');
          hint.className = 'hint';
          hint.textContent = '没有匹配 "' + q + '" 的邮件';
          listEl.appendChild(hint);
          return;
        }
        msgs.forEach(function (m) { listEl.appendChild(rowEl(m)); });
      }).catch(function (err) { showBanner(err.message); });
    };
  }
  document.getElementById('fetchBtn').onclick = function () {
    var btn = document.getElementById('fetchBtn');
    var loading = document.getElementById('fetchLoading');
    var orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-rotate fa-spin"></i> 收信';
    loading.style.display = 'flex';
    loadFolders().then(function () {
      return loadList().then(silentRefresh);
    }).then(function () {
      /* 静默完成，不弹 banner */
    }).catch(function (err) {
      showBanner(err && err.message ? err.message : '收信失败');
    }).finally(function () {
      loading.style.display = 'none';
      btn.disabled = false;
      btn.innerHTML = orig;
    });
  };
  setInterval(function () {
    var compose = document.getElementById('composeModal');
    if (compose && compose.open) return;
    if (document.getElementById('loginView') && document.getElementById('loginView').classList.contains('active')) return;
    silentRefresh();
  }, 60000);
  document.getElementById('more').onclick = function () {
    state.offset += state.limit;
    loadList();
  };
  document.getElementById('addLabelBtn').onclick = function () {
    openLabelModal(null);
  };
  document.getElementById('labelsToggle').onclick = function () {
    var g = document.getElementById('labelsGroup');
    var expanded = g.classList.toggle('expanded');
    document.getElementById('labels').style.display = expanded ? '' : 'none';
    if (expanded) loadLabels();
  };
  document.getElementById('aiAssistantBtn').onclick = function () {
    document.getElementById('aiPanel').style.display = '';
  };
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'ai-close-panel') {
      document.getElementById('aiPanel').style.display = 'none';
    }
  });
  var composeEditor = document.getElementById('composeEditor');
  function exec(cmd, val) {
    document.execCommand(cmd, false, val || null);
    composeEditor.focus();
    updateTbActive();
  }
  function updateTbActive() {
    var items = document.querySelectorAll('#composeModal .tool-btn[data-cmd]');
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var cmd = it.dataset.cmd;
      try {
        var on = document.queryCommandState(cmd);
        it.classList.toggle('active', !!on);
      } catch { /* ignore */ }
    }
  }
  document.querySelectorAll('#composeModal .tool-btn[data-cmd]').forEach(function (el) {
    el.onclick = function () { exec(el.dataset.cmd); };
  });
  document.getElementById('composeFontName').onchange = function () { exec('fontName', this.value); this.value = ''; };
  document.getElementById('composeFontSize').onchange = function () { exec('fontSize', this.value); this.value = ''; };
  document.getElementById('composeForeColor').onchange = function () { exec('foreColor', this.value); };
  composeEditor.onkeyup = updateTbActive;
  composeEditor.onmouseup = updateTbActive;

  document.getElementById('composeCcToggle').onclick = function () {
    var row = document.getElementById('composeCcRow');
    row.style.display = row.style.display === 'none' ? '' : 'none';
  };

  function openPreview() {
    var to = document.getElementById('composeTo').value.trim();
    var cc = document.getElementById('composeCc').value.trim();
    var subject = document.getElementById('composeSubject').value.trim();
    var html = composeEditor.innerHTML;
    var text = composeEditor.innerText.trim();
    var w = window.open('', '_blank', 'width=720,height=600');
    if (!w) { document.getElementById('composeMsg').textContent = '预览窗口被浏览器拦截'; return; }
    var from = document.getElementById('composeFrom').textContent || '';
    w.document.open();
    w.document.write('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>邮件预览</title>' +
      '<style>body{font:13px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#333;padding:24px;max-width:680px;margin:0 auto}' +
      '.hd{border-bottom:1px solid #eee;padding-bottom:12px;margin-bottom:16px} .hd h2{font-size:16px;margin:0 0 8px}' +
      '.row{color:#666;font-size:12px;margin:2px 0} .row b{color:#333;font-weight:600} .body{margin-top:12px;min-height:200px}</style></head><body>' +
      '<div class="hd"><h2>' + esc(subject || '(无主题)') + '</h2>' +
      '<div class="row"><b>发件人：</b>' + esc(from) + '</div>' +
      '<div class="row"><b>收件人：</b>' + esc(to || '(空)') + '</div>' +
      (cc ? '<div class="row"><b>抄送：</b>' + esc(cc) + '</div>' : '') +
      '</div><div class="body">' + (html || '<pre style="white-space:pre-wrap;font:inherit;margin:0">' + esc(text) + '</pre>') + '</div></body></html>');
    w.document.close();
  }
  document.getElementById('composePreview').onclick = openPreview;

  function saveDraft() {
    var draft = {
      to: document.getElementById('composeTo').value,
      cc: document.getElementById('composeCc').value,
      subject: document.getElementById('composeSubject').value,
      html: composeEditor.innerHTML,
      attachments: document.getElementById('composeAttachments').value,
      savedAt: new Date().toISOString(),
    };
    try {
      localStorage.setItem('dsh-email-draft', JSON.stringify(draft));
      showBanner('草稿已保存到本地（' + new Date().toLocaleString('zh-CN', { hour12: false }) + '）');
    } catch (e) {
      document.getElementById('composeMsg').textContent = '草稿保存失败：' + (e && e.message || e);
    }
  }
  function loadDraft() {
    try {
      var raw = localStorage.getItem('dsh-email-draft');
      if (!raw) return;
      var d = JSON.parse(raw);
      document.getElementById('composeTo').value = d.to || '';
      document.getElementById('composeCc').value = d.cc || '';
      document.getElementById('composeSubject').value = d.subject || '';
      composeEditor.innerHTML = d.html || '';
      document.getElementById('composeAttachments').value = d.attachments || '';
      if (d.cc) document.getElementById('composeCcRow').style.display = '';
    } catch { /* ignore */ }
  }
  document.getElementById('composeDraft').onclick = saveDraft;

  var attachInput = document.getElementById('composeAttachInput');
  var attachField = document.getElementById('composeAttachments');
  document.getElementById('composeAttachBtn').onclick = function () { attachInput.click(); };
  attachInput.onchange = function () {
    var files = attachInput.files;
    if (!files || files.length === 0) return;
    var msg = document.getElementById('composeMsg');
    msg.textContent = '上传中…';
    var fd = new FormData();
    for (var i = 0; i < files.length; i++) fd.append('file', files[i], files[i].name);
    fetch(BASE + '/api/upload', { method: 'POST', body: fd }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (d) {
        if (!res.ok || !d || !d.ok) throw new Error((d && d.error && d.error.message) || ('HTTP ' + res.status));
        return d.value;
      });
    }).then(function (v) {
      var existing = attachField.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      (v.paths || []).forEach(function (p) { existing.push(p); });
      attachField.value = existing.join(', ');
      msg.textContent = '';
      attachInput.value = '';
    }).catch(function (err) {
      msg.textContent = err.message;
      attachInput.value = '';
    });
  };

  function loadFromInfo() {
    fetch(BASE + '/api/me' + qs({ account: state.account })).then(function (res) {
      return res.json().catch(function () { return null; });
    }).then(function (d) {
      if (d && d.ok && d.value) {
        document.getElementById('composeFrom').textContent = d.value.user || d.value.account;
      } else {
        document.getElementById('composeFrom').textContent = state.account || 'default';
      }
    }).catch(function () {
      document.getElementById('composeFrom').textContent = state.account || 'default';
    });
  }

  function doSend() {
    var to = document.getElementById('composeTo').value.trim();
    var cc = document.getElementById('composeCc').value.trim();
    var subject = document.getElementById('composeSubject').value.trim();
    var html = composeEditor.innerHTML.trim();
    var text = composeEditor.innerText.trim();
    var atts = document.getElementById('composeAttachments').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var msg = document.getElementById('composeMsg');
    if (!to) { msg.textContent = '请填写收件人'; return; }
    if (!subject && !text) { msg.textContent = '主题和正文不能同时为空'; return; }
    msg.textContent = '';
    var btns = [document.getElementById('composeSend'), document.getElementById('composeSend2')];
    btns.forEach(function (b) { b.disabled = true; b.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 发送中…'; });
    fetch(BASE + '/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account: state.account, to: to, cc: cc, subject: subject,
        text: text || undefined, html: html || undefined, attachments: atts,
      }),
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (d) {
        if (!res.ok || !d || !d.ok) throw new Error((d && d.error && d.error.message) || ('HTTP ' + res.status));
        return d.value;
      });
    }).then(function (v) {
      btns.forEach(function (b) { b.disabled = false; b.innerHTML = '<i class="fa-solid fa-paper-plane"></i> 发送'; });
      document.getElementById('composeModal').close();
      showBanner('已发送至 ' + (v.accepted || []).join(', ') + '（' + v.messageId + '）');
      resetCompose();
    }).catch(function (err) {
      msg.textContent = err.message;
      btns.forEach(function (b) { b.disabled = false; b.innerHTML = '<i class="fa-solid fa-paper-plane"></i> 发送'; });
    });
  }
  function resetCompose() {
    document.getElementById('composeTo').value = '';
    document.getElementById('composeCc').value = '';
    document.getElementById('composeSubject').value = '';
    document.getElementById('composeAttachments').value = '';
    composeEditor.innerHTML = '';
    document.getElementById('composeCcRow').style.display = 'none';
    document.getElementById('composeMsg').textContent = '';
  }
  document.getElementById('composeBtn').onclick = function () {
    loadFromInfo();
    loadDraft();
    document.getElementById('composeModal').showModal();
    document.getElementById('composeTo').focus();
  };
  function startReply(orig) {
    loadFromInfo();
    document.getElementById('composeTo').value = orig.to || '';
    document.getElementById('composeCc').value = '';
    var subj = orig.subject || '';
    document.getElementById('composeSubject').value = /^Re:/i.test(subj) ? subj : 'Re: ' + subj;
    composeEditor.innerHTML = '';
    document.getElementById('composeCcRow').style.display = 'none';
    document.getElementById('composeModal').showModal();
    composeEditor.focus();
  }
  document.getElementById('composeCancel').onclick = function () { document.getElementById('composeModal').close(); };
  document.getElementById('composeCancel2').onclick = function () { document.getElementById('composeModal').close(); };
  document.getElementById('composeSend').onclick = doSend;
  document.getElementById('composeSend2').onclick = doSend;
  document.getElementById('composeForm').onsubmit = function (e) { e.preventDefault(); doSend(); };
  document.getElementById('labelCancel').onclick = function () {
    document.getElementById('labelModal').close();
  };
  document.getElementById('labelForm').onsubmit = function (e) {
    e.preventDefault();
    var id = document.getElementById('labelId').value || ('lbl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));
    var name = document.getElementById('labelName').value.trim();
    var kws = document.getElementById('labelKeywords').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var color = document.getElementById('labelColor').value || LABEL_COLORS[0];
    var msg = document.getElementById('labelMsg');
    if (!name) { msg.textContent = '请填写标签名称'; return; }
    msg.textContent = '';
    fetch(BASE + '/api/labels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, name: name, keywords: kws, color: color }),
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (d) {
        if (!res.ok || !d || !d.ok) throw new Error((d && d.error && d.error.message) || ('HTTP ' + res.status));
      });
    }).then(function () {
      document.getElementById('labelModal').close();
      loadLabels();
    }).catch(function (err) { msg.textContent = err.message; });
  };

  function showLogin() {
    document.getElementById('loginView').classList.add('active');
    document.getElementById('mainView').style.display = 'none';
    document.getElementById('banner').style.display = 'none';
    fetch(BASE + '/api/me').then(function (res) { return res.json().catch(function () { return null; }); }).then(function (d) {
      if (d && d.ok && d.value && d.value.user) {
        var u = document.getElementById('loginUser');
        if (u && !u.value) u.value = d.value.user;
      }
    });
  }
  function showMain() {
    document.getElementById('loginView').classList.remove('active');
    document.getElementById('mainView').style.display = '';
  }

  document.getElementById('loginForm').onsubmit = function (e) {
    e.preventDefault();
    var provider = document.getElementById('loginProvider').value;
    var user = document.getElementById('loginUser').value.trim();
    var password = document.getElementById('loginPass').value;
    var msg = document.getElementById('loginMsg');
    var btn = document.getElementById('loginBtn');
    if (!user) { msg.textContent = '请填写邮箱地址'; return; }
    if (!password) { msg.textContent = '请填写AD密码'; return; }
    msg.textContent = '';
    btn.disabled = true;
    btn.textContent = '登录中…';
    fetch(BASE + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: provider, user: user, password: password }),
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok || !data || !data.ok) {
          throw new Error((data && data.error && data.error.message) || ('HTTP ' + res.status));
        }
      });
    }).then(function () {
      btn.textContent = '已保存，加载中…';
      showMain();
      loadFolders().then(loadList).then(loadLabels).then(loadTodoCount).catch(function (err) {
        showBanner(err.message);
      });
    }).catch(function (err) {
      msg.textContent = err.message;
      btn.disabled = false;
      btn.textContent = '登录';
    });
  };

  loadFolders().then(function () {
    showMain();
    loadList();
    loadLabels();
  }).catch(function (err) {
    var msg = String(err && err.message || err);
    if (msg.indexOf('未配置') >= 0 || msg.indexOf('未填写') >= 0 || msg.indexOf('user') >= 0 || msg.indexOf('password') >= 0 || msg.indexOf('host') >= 0) {
      showLogin();
    } else {
      showMain();
      showBanner(msg);
    }
  });
})();
</script>
</body>
</html>`
}
