/** One address entry as IMAP/MIME expose it. */
export interface AddressEntry {
  name?: string
  address?: string
}

/** One listed message: everything cheap to fetch without the body. */
export interface ListedMessage {
  uid: number
  /** ISO 8601 string, or '' when unknown. Kept as UTC so MIME Date headers
   *  (e.g. on forward) round-trip through `new Date(...).toUTCString()`. */
  date: string
  /** Same instant as `date`, formatted as 'YYYY-MM-DD HH:MM:SS' in Asia/Shanghai.
   *  Use this for display in the inbox UI and for the LLM-facing tool output. */
  dateLocal?: string
  from: AddressEntry[]
  /** To recipients from the envelope; allows the UI to render headers before the body loads. */
  to?: AddressEntry[]
  /** CC recipients from the envelope; used to auto-fill CC on reply/forward. */
  cc?: AddressEntry[]
  subject: string
  seen: boolean
  flagged: boolean
  size: number
  hasAttachments: boolean
  /** Source folder; set when the message comes from a cross-folder (label) query. */
  folder?: string
}

/** One attachment of a read message (metadata only). */
export interface EmailAttachmentMeta {
  filename: string
  contentType: string
  size: number
  /** IMAP body part identifier used by email_attachment. */
  part: string
}

/** One fully read message body. */
export interface ReadMessageBody {
  /** ISO 8601 string in UTC, or '' when unknown. */
  date: string
  /** Same instant as `date`, formatted as 'YYYY-MM-DD HH:MM:SS' in Asia/Shanghai. */
  dateLocal?: string
  from: AddressEntry[]
  to: AddressEntry[]
  cc: AddressEntry[]
  subject: string
  /** Plain-text body; HTML mail is converted. Truncated at maxBodyChars. */
  text: string
  /** Original HTML body for HTML-capable callers (e.g. forward). Empty when the source has no HTML part. Truncated at maxBodyChars. */
  html: string
  attachments: EmailAttachmentMeta[]
  truncated: boolean
}

export interface EmailListResult {
  account: string
  count: number
  folder: string
  messages: ListedMessage[]
}

export interface EmailReadResult extends ReadMessageBody {
  account: string
  uid: number
  folder: string
}

export interface EmailSearchResult {
  account: string
  query: string
  count: number
  folder: string
  messages: ListedMessage[]
}

export interface EmailSendResult {
  account: string
  messageId: string
  accepted: string[]
  rejected: string[]
  response: string
}

export interface EmailFolderRow {
  name: string
  path: string
  /** IMAP hierarchy delimiter, usually "." or "/". */
  delimiter: string
  /** Full path of the parent mailbox; empty for a root mailbox. */
  parentPath: string
  specialUse: string
  subscribed: boolean
  /** False for hierarchy-only mailboxes carrying the IMAP \\Noselect flag. */
  selectable: boolean
  /** Total message count (from IMAP STATUS), -1 when not fetched. */
  total: number
  /** Unseen count (from IMAP STATUS), -1 when not fetched. */
  unread: number
}

export interface EmailFoldersResult {
  account: string
  folders: EmailFolderRow[]
}

export interface EmailAttachmentResult {
  account: string
  uid: number
  filename: string
  contentType: string
  size: number
  /** Absolute path the attachment was written to. */
  path: string
}

/** Every tool accepts an optional account selector. */
export interface AccountArg {
  account?: string
}

export interface EmailListArgs extends AccountArg {
  folder?: string
  limit?: number
  offset?: number
  unreadOnly?: boolean
}

export interface EmailReadArgs extends AccountArg {
  uid: number
  folder?: string
}

export interface EmailSearchArgs extends AccountArg {
  query: string
  folder?: string
  limit?: number
  /** Field to search; defaults to all searchable headers plus body fallback. */
  field?: 'all' | 'body' | 'subject' | 'from' | 'recipient'
}

export interface EmailSendArgs extends AccountArg {
  to: string
  subject: string
  text?: string
  cc?: string
  /** Absolute paths (or paths relative to the dsh process cwd) to attach. */
  attachments?: string[]
}

export interface EmailFoldersArgs extends AccountArg {
  subscribedOnly?: boolean
}

export interface EmailAttachmentArgs extends AccountArg {
  uid: number
  /** 0-based index into the attachments of email_read. Default 0. */
  index?: number
  folder?: string
}
