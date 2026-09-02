import { homedir } from 'node:os'
import { parse as parseYaml } from 'yaml'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

export type ProviderName = 'qq' | '163' | '126' | 'sina' | 'aliyun' | 'gmail' | 'outlook' | 'icloud' | 'webank' | 'coremail'

export interface ImapConfig {
  host?: string
  port?: number
  secure?: boolean
  connectionTimeoutMs?: number
  socketTimeoutMs?: number
}

export interface SmtpConfig {
  host?: string
  port?: number
  secure?: boolean
}

/** One mailbox account. Top-level shorthand fields act as shared defaults. */
export interface AccountConfig {
  provider?: ProviderName
  user?: string
  password?: string
  imap?: ImapConfig
  smtp?: SmtpConfig
  inboxFolder?: string
  /** Per-account TLS options. `insecure` and `caPath` are mutually exclusive. */
  tls?: AccountTlsOptions
}

/** Per-account TLS options for intranet/self-signed CA scenarios. */
export interface AccountTlsOptions {
  /** Skip server certificate verification. Explicit security downgrade. */
  insecure?: boolean
  /** Path to a PEM file with an extra CA to trust. Preserves verification. */
  caPath?: string
}

export interface EmailConfig extends AccountConfig {
  /** Ask the user for approval before email_send. Default true. */
  sendApproval?: boolean
  /** Plain-text body cap for email_read. Default 20000. */
  maxBodyChars?: number
  /** Named accounts. Account-level fields override the top-level shorthand. */
  accounts?: Record<string, AccountConfig>
  /** YAML text of the accounts map, editable from the settings page. Wins over accounts when non-empty. */
  accountsYaml?: string
  /** Which account tools use when the call omits account. Required with 2+ accounts. */
  defaultAccount?: string
  /** Directory email_attachment writes into. Default: the session workspace's .dsh-email-downloads (falls back to $DSH_HOME/email-downloads). */
  downloadDir?: string
  /** Client-side body scan when server search finds nothing. Default true. */
  bodySearchFallback?: boolean
  /** How many recent messages the body-search fallback parses. Default 30. */
  bodySearchLimit?: number
  /** Per-attachment and total-attachment byte cap. Default 20 MiB. */
  maxAttachmentBytes?: number
  /** Unused IMAP connections close after this many ms. Default 60000. */
  idleTimeoutMs?: number
}

export interface ProviderPreset {
  imap: { host: string; port: number; secure: boolean }
  smtp: { host: string; port: number; secure: boolean }
  /** Default TLS options for this provider (e.g. webank intranet self-signed CA). */
  tls?: AccountTlsOptions
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  qq: { imap: { host: 'imap.qq.com', port: 993, secure: true }, smtp: { host: 'smtp.qq.com', port: 465, secure: true } },
  '163': { imap: { host: 'imap.163.com', port: 993, secure: true }, smtp: { host: 'smtp.163.com', port: 465, secure: true } },
  '126': { imap: { host: 'imap.126.com', port: 993, secure: true }, smtp: { host: 'smtp.126.com', port: 465, secure: true } },
  sina: { imap: { host: 'imap.sina.com', port: 993, secure: true }, smtp: { host: 'smtp.sina.com', port: 465, secure: true } },
  aliyun: { imap: { host: 'imap.aliyun.com', port: 993, secure: true }, smtp: { host: 'smtp.aliyun.com', port: 465, secure: true } },
  gmail: { imap: { host: 'imap.gmail.com', port: 993, secure: true }, smtp: { host: 'smtp.gmail.com', port: 465, secure: true } },
  outlook: { imap: { host: 'outlook.office365.com', port: 993, secure: true }, smtp: { host: 'smtp.office365.com', port: 587, secure: false } },
  icloud: { imap: { host: 'imap.mail.me.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.me.com', port: 587, secure: false } },
  // WeBank (Coremail deployment, intranet-only hosts). WeBank OA enterprise CA is
  // not in Node's bundled cacert.pem, so default to skipping verification — this
  // is a per-provider downgrade, scoped only to webank IMAP/SMTP connections.
  // Switch to tls.caPath once the enterprise CA PEM is available.
  webank: {
    imap: { host: 'wemail.webank.com', port: 993, secure: true },
    smtp: { host: 'wemail.webank.com', port: 465, secure: true },
    tls: { insecure: true },
  },
}

export const PROVIDER_NAMES = [...Object.keys(PROVIDER_PRESETS), 'coremail']

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/

/**
 * Coremail deployments (many universities and enterprises) conventionally
 * expose imap.<domain> / smtp.<domain>: derive the hosts from the email
 * address itself. Explicit imap/smtp config still wins over these defaults.
 */
function coremailPresetFor(name: string, user: string): ProviderPreset {
  const domain = user.split('@')[1]?.toLowerCase() ?? ''
  if (!DOMAIN_RE.test(domain)) {
    throw new Error(`dsh-email：账号 "${name}" 使用 provider "coremail" 时 user 必须是完整邮箱地址（用于推导服务器主机名），当前为 "${user}"`)
  }
  return {
    imap: { host: 'imap.' + domain, port: 993, secure: true },
    smtp: { host: 'smtp.' + domain, port: 465, secure: true },
  }
}

export const EMAIL_PASSWORD_ENV = 'DSH_EMAIL_PASSWORD'

const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
const DEFAULT_IDLE_TIMEOUT_MS = 60000

/** Fully resolved, validated configuration for one account. */
export interface ResolvedEmailConfig {
  user: string
  password: string
  imap: ImapConfig & { host: string; port: number; secure: boolean }
  smtp: SmtpConfig & { host: string; port: number; secure: boolean }
  inboxFolder: string
  /** Resolved TLS options. `ca` is the loaded PEM Buffer when `caPath` is set. */
  tls: { insecure: boolean; ca?: Buffer }
}

/** Fully resolved plugin settings: the account map plus shared policy. */
export interface ResolvedEmailSettings {
  accounts: Map<string, ResolvedEmailConfig>
  defaultAccount: string
  sendApproval: boolean
  maxBodyChars: number
  downloadDir: string
  /** Whether downloadDir was set explicitly (vs. the default). */
  downloadDirExplicit: boolean
  maxAttachmentBytes: number
  idleTimeoutMs: number
  bodySearchFallback: boolean
  bodySearchLimit: number
}

export function defaultDownloadDir(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'email-downloads')
}

/**
 * Parse the settings-page accounts YAML: an object map (name -> account),
 * optionally with a reserved string key defaultAccount that is extracted.
 */
export function parseAccountsYaml(text: string): { map: Record<string, AccountConfig>; defaultAccount?: string } {
  let doc: unknown
  try {
    doc = parseYaml(text)
  } catch (error) {
    throw new Error('dsh-email：accountsYaml 不是合法的 YAML：' + (error instanceof Error ? error.message : String(error)))
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('dsh-email：accountsYaml 必须是一个对象映射（账号名 -> 账号配置），例如 work: { provider: qq, user: a@b.c, password: xxx }')
  }
  const map: Record<string, AccountConfig> = {}
  let defaultAccount: string | undefined
  for (const [key, value] of Object.entries(doc as Record<string, unknown>)) {
    if (key === 'defaultAccount') {
      if (typeof value === 'string' && value !== '') defaultAccount = value
      continue
    }
    map[key] = value as AccountConfig
  }
  return { map, defaultAccount }
}

/**
 * Resolve and validate the raw row config. Throws with an actionable message
 * (in Chinese, since it is what the user and the model both read) when the
 * account is not fully specified.
 */
export function resolveEmailSettings(config: EmailConfig | undefined): ResolvedEmailSettings {
  const raw = config ?? {}
  const common: AccountConfig = {
    provider: raw.provider,
    user: raw.user,
    password: raw.password,
    imap: raw.imap,
    smtp: raw.smtp,
    inboxFolder: raw.inboxFolder,
  }
  const parsedYaml = raw.accountsYaml?.trim() ? parseAccountsYaml(raw.accountsYaml) : undefined
  const entries = parsedYaml !== undefined
    ? parsedYaml.map
    : (raw.accounts === undefined || Object.keys(raw.accounts).length === 0 ? undefined : raw.accounts)
  const accounts = new Map<string, ResolvedEmailConfig>()
  if (entries === undefined) {
    accounts.set('default', resolveAccount('default', common, {}, true))
  } else {
    for (const [name, acc] of Object.entries(entries)) {
      accounts.set(name, resolveAccount(name, common, acc ?? {}, false))
    }
  }
  let defaultName: string
  if (raw.defaultAccount !== undefined && raw.defaultAccount !== '') {
    if (!accounts.has(raw.defaultAccount)) {
      throw new Error(`dsh-email：defaultAccount "${raw.defaultAccount}" 不存在，可用账号：${[...accounts.keys()].join('、')}`)
    }
    defaultName = raw.defaultAccount
  } else if (accounts.size === 1) {
    defaultName = [...accounts.keys()][0]
  } else if (parsedYaml?.defaultAccount !== undefined && accounts.has(parsedYaml.defaultAccount)) {
    defaultName = parsedYaml.defaultAccount
  } else if (accounts.has('default')) {
    defaultName = 'default'
  } else {
    throw new Error(`dsh-email：配置了多个账号（${[...accounts.keys()].join('、')}），请设置 defaultAccount 指定默认账号`)
  }
  return {
    accounts,
    defaultAccount: defaultName,
    sendApproval: raw.sendApproval !== false,
    maxBodyChars: clampInt(raw.maxBodyChars, 20000, 1000, 200000),
    downloadDir: raw.downloadDir?.trim() || defaultDownloadDir(),
    downloadDirExplicit: (raw.downloadDir?.trim() ?? '') !== '',
    maxAttachmentBytes: clampInt(raw.maxAttachmentBytes, DEFAULT_MAX_ATTACHMENT_BYTES, 1024, 512 * 1024 * 1024),
    idleTimeoutMs: clampInt(raw.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, 5000, 600000),
    bodySearchFallback: raw.bodySearchFallback !== false,
    bodySearchLimit: clampInt(raw.bodySearchLimit, 30, 5, 200),
  }
}

/** Merge one account over the shared shorthand and validate it. */
function resolveAccount(name: string, common: AccountConfig, acc: AccountConfig, allowEnvPassword: boolean): ResolvedEmailConfig {
  const user = (acc.user ?? common.user ?? '').trim()
  const provider = acc.provider ?? common.provider
  let preset: ProviderPreset | undefined
  if (provider === 'coremail') {
    preset = coremailPresetFor(name, user)
  } else {
    preset = PROVIDER_PRESETS[provider ?? '']
    if (provider !== undefined && preset === undefined) {
      throw new Error(`dsh-email：账号 "${name}" 的 provider "${provider}" 未知，可选：${PROVIDER_NAMES.join('/')}；或省略 provider 直接填 imap.host 与 smtp.host`)
    }
  }
  const password = acc.password ?? common.password ?? (allowEnvPassword ? process.env[EMAIL_PASSWORD_ENV] ?? '' : '')
  const tlsOpts = acc.tls ?? common.tls ?? preset?.tls
  const imap = {
    host: acc.imap?.host ?? common.imap?.host ?? preset?.imap.host,
    port: acc.imap?.port ?? common.imap?.port ?? preset?.imap.port,
    secure: acc.imap?.secure ?? common.imap?.secure ?? preset?.imap.secure,
    connectionTimeoutMs: acc.imap?.connectionTimeoutMs ?? common.imap?.connectionTimeoutMs,
    socketTimeoutMs: acc.imap?.socketTimeoutMs ?? common.imap?.socketTimeoutMs,
  }
  const smtp = {
    host: acc.smtp?.host ?? common.smtp?.host ?? preset?.smtp.host,
    port: acc.smtp?.port ?? common.smtp?.port ?? preset?.smtp.port,
    secure: acc.smtp?.secure ?? common.smtp?.secure ?? preset?.smtp.secure,
  }
  const tls = resolveTls(name, tlsOpts)
  const problems: string[] = []
  if (user === '') problems.push(`账号 "${name}" 的 user（邮箱地址）未填写`)
  if (password === '') problems.push(`账号 "${name}" 的 password 未填写（单账号可用环境变量 ${EMAIL_PASSWORD_ENV}）`)
  if (imap.host === undefined || imap.host === '') problems.push(`账号 "${name}" 的 imap.host 未填写（可填 provider 预设：${PROVIDER_NAMES.join('/')}）`)
  if (smtp.host === undefined || smtp.host === '') problems.push(`账号 "${name}" 的 smtp.host 未填写（同上）`)
  if (problems.length > 0) {
    throw new Error(`dsh-email 未配置：${problems.join('；')}。请在 profile 的 cordis.patch.yml 中覆盖 tool-email 行并重启（见插件 README）`)
  }
  return {
    user,
    password,
    imap: { ...imap, host: imap.host!, port: imap.port!, secure: imap.secure! },
    smtp: { ...smtp, host: smtp.host!, port: smtp.port!, secure: smtp.secure! },
    inboxFolder: (acc.inboxFolder ?? common.inboxFolder ?? '').trim() || 'INBOX',
    tls,
  }
}

/** Resolve and validate per-account TLS options. `insecure` and `caPath` are mutually exclusive. */
function resolveTls(name: string, opts: AccountTlsOptions | undefined): { insecure: boolean; ca?: Buffer } {
  const insecure = opts?.insecure === true
  const caPath = opts?.caPath?.trim()
  if (insecure && caPath) {
    throw new Error(`dsh-email：账号 "${name}" 的 tls.insecure 与 tls.caPath 不能同时设置（要么跳过校验，要么信任指定 CA，二选一）`)
  }
  if (caPath === '') return { insecure }
  if (caPath === undefined) return { insecure }
  let ca: Buffer
  try {
    ca = readFileSync(caPath)
  } catch (error) {
    throw new Error(`dsh-email：账号 "${name}" 的 tls.caPath "${caPath}" 读取失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!/-----BEGIN CERTIFICATE-----/.test(ca.toString('utf8'))) {
    throw new Error(`dsh-email：账号 "${name}" 的 tls.caPath "${caPath}" 不是合法的 PEM 证书文件（缺 "-----BEGIN CERTIFICATE-----" 标记）`)
  }
  return { insecure, ca }
}

/** v0.1-compatible wrapper: resolve the single (or default) account. */
export function resolveEmailConfig(config: EmailConfig | undefined): ResolvedEmailConfig {
  const settings = resolveEmailSettings(config)
  return settings.accounts.get(settings.defaultAccount)!
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? Math.trunc(value) : fallback
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}