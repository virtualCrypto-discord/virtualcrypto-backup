import { DurableObject } from 'cloudflare:workers';

export const LIMITS = { object: 32 * 1024 * 1024, stored: 1024 * 1024 * 1024, daily: 3, timeoutMs: 120_000, retentionDays: 36, headsDaily: 128, entries: 256 };
interface Env { BACKUPS: R2Bucket; GATE: DurableObjectNamespace<BackupGate>; MTLS_HOST: string; CLIENT_CERT_SHA256: string; STATUS_TOKEN: string; DISCORD_WEBHOOK_URL?: string }
interface Entry { id: string; key: string; bytes: number; sha256: string; at: number; status: 'pending' | 'complete' | 'failed'; checkedAt?: number }
interface Ledger { entries: Entry[]; day: string; attempts: number; lastSuccess: number | null; headDay?: string; heads?: number; monitoringSince?: number; alertDay?: string }
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
async function authorized(request: Request, secret: string): Promise<boolean> {
  if (!secret || secret.length < 32) return false;
  const provided = request.headers.get('authorization') ?? '';
  if (provided.length > 256) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([provided, `Bearer ${secret}`].map(x => crypto.subtle.digest('SHA-256', encoder.encode(x))));
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i];
  return difference === 0;
}
function authenticatedClient(request: Request, env: Env): boolean {
  if (new URL(request.url).hostname !== env.MTLS_HOST) return false;
  const tls = request.cf?.tlsClientAuth as { certPresented?: string; certVerified?: string; certRevoked?: string; certFingerprintSHA256?: string } | undefined;
  if (tls?.certPresented !== '1' || tls.certVerified !== 'SUCCESS' || tls.certRevoked !== '0') return false;
  const fingerprint = tls.certFingerprintSHA256?.toLowerCase();
  if (!fingerprint || !/^[a-f0-9]{64}$/.test(fingerprint)) return false;
  // Multiple pins allow overlap during certificate rotation. Only edge-provided
  // TLS metadata is trusted; forwarded certificate headers are never consulted.
  return (env.CLIENT_CERT_SHA256 ?? '').split(',').map(x => x.trim().toLowerCase())
    .some(pin => /^[a-f0-9]{64}$/.test(pin) && pin === fingerprint);
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/upload' && request.method === 'POST') {
      if (!authenticatedClient(request, env)) return json({ error: 'client_certificate_required' }, 403);
    } else if (path === '/status' && request.method === 'GET') {
      if (!authenticatedClient(request, env)) return json({ error: 'client_certificate_required' }, 403);
      if (!await authorized(request, env.STATUS_TOKEN)) return json({ error: 'unauthorized' }, 401);
    } else return json({ error: 'not_found' }, 404);
    return env.GATE.getByName('production-v1').fetch(request);
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const result = await env.GATE.getByName('production-v1').fetch('https://internal/reconcile', { method: 'POST' });
    if (!result.ok) throw new Error('Backup inventory reconciliation failed');
  }
} satisfies ExportedHandler<Env>;

export class BackupGate extends DurableObject<Env> {
  private empty(): Ledger { return { entries: [], day: '', attempts: 0, lastSuccess: null }; }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/status') {
      const ledger = await this.ctx.storage.get<Ledger>('ledger') ?? this.empty();
      return json({ last_success: ledger.lastSuccess, reserved_bytes: ledger.entries.reduce((n, e) => n + e.bytes, 0), limits: LIMITS });
    }
    if (path === '/reconcile') return this.reconcile();
    if (path !== '/upload') return json({ error: 'not_found' }, 404);
    const rawLength = request.headers.get('content-length') ?? '';
    const bytes = Number(rawLength);
    if (!/^\d+$/.test(rawLength) || !Number.isSafeInteger(bytes) || bytes < 24 || bytes > LIMITS.object) return json({ error: 'size_limit' }, 413);
    if (!request.body || request.headers.get('content-type') !== 'application/octet-stream' || request.headers.has('content-encoding')) return json({ error: 'invalid_body' }, 400);
    const id = request.headers.get('x-backup-id') ?? '';
    const sha256 = request.headers.get('x-backup-sha256') ?? '';
    if (!/^[0-9a-f-]{36}$/.test(id) || !/^[0-9a-f]{64}$/.test(sha256)) return json({ error: 'invalid_metadata' }, 400);
    const now = Date.now(), day = new Date(now).toISOString().slice(0, 10);
    // Reserve persistent quota BEFORE reading the body. Failed attempts retain their
    // reservation; retries cannot mint unlimited storage or R2 operations.
    const reservation = await this.ctx.storage.transaction(async tx => {
      const ledger = await tx.get<Ledger>('ledger') ?? this.empty();
      const existing = ledger.entries.find(e => e.id === id);
      if (existing) {
        if (existing.bytes === bytes && existing.sha256 === sha256 && existing.status === 'complete') return { existing };
        return { error: 'id_conflict', status: 409 };
      }
      if (day < ledger.day) return { error: 'clock_regressed', status: 503 };
      if (day !== ledger.day) { ledger.day = day; ledger.attempts = 0; }
      if (ledger.entries.length >= LIMITS.entries || ledger.attempts >= LIMITS.daily || ledger.entries.reduce((n, e) => n + e.bytes, 0) + bytes > LIMITS.stored) return { error: 'quota_exceeded', status: 429 };
      if (ledger.entries.some(e => e.status === 'pending' && now - e.at < LIMITS.timeoutMs + 60_000)) return { error: 'upload_in_progress', status: 409 };
      const entry: Entry = { id, key: `production/${day}/${crypto.randomUUID()}.dump.age`, bytes, sha256, at: now, status: 'pending' };
      ledger.attempts++;
      ledger.entries.push(entry);
      await tx.put('ledger', ledger);
      return { entry };
    });
    if ('error' in reservation) return json({ error: reservation.error }, reservation.status);
    if ('existing' in reservation) return json({ key: reservation.existing!.key, sha256, bytes, duplicate: true });
    const entry = reservation.entry!;
    // Buffer at most one admitted 32 MiB body. Validate it before touching R2,
    // avoiding partial writes and stream failures inside the storage API.
    const reader = request.body.getReader();
    const buffer = new Uint8Array(bytes);
    let expired = false;
    const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}); }, LIMITS.timeoutMs);
    let complete = false;
    try {
      let count = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (expired) throw new Error('upload timeout');
        if (done) break;
        if (count + value.byteLength > bytes) throw new Error('body length exceeded');
        buffer.set(value, count);
        count += value.byteLength;
      }
      if (count !== bytes) throw new Error('body length mismatch');
      const prefix = new TextEncoder().encode('age-encryption.org/v1\n');
      if (!prefix.every((v, i) => buffer[i] === v)) throw new Error('age envelope required');
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
      const actual = Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
      if (actual !== sha256) throw new Error('checksum mismatch');
      const object = await this.env.BACKUPS.put(entry.key, buffer, {
        onlyIf: { etagDoesNotMatch: '*' }, sha256,
        customMetadata: { backup_id: id, sha256 },
        httpMetadata: { contentType: 'application/octet-stream' }
      });
      complete = object !== null;
    } catch { await reader.cancel().catch(() => {}); }
    finally { clearTimeout(timer); }
    await this.ctx.storage.transaction(async tx => {
      const ledger = (await tx.get<Ledger>('ledger'))!;
      ledger.entries.find(e => e.key === entry.key)!.status = complete ? 'complete' : 'failed';
      if (complete) ledger.lastSuccess = Date.now();
      await tx.put('ledger', ledger);
    });
    return complete ? json({ key: entry.key, sha256, bytes }, 201) : json({ error: 'upload_failed' }, 400);
  }
  private async reconcile(): Promise<Response> {
    const now = Date.now(), day = new Date(now).toISOString().slice(0, 10);
    // Reserve the read budget persistently BEFORE calling R2, including failures.
    const candidates = await this.ctx.storage.transaction(async tx => {
      const ledger = await tx.get<Ledger>('ledger') ?? this.empty();
      if (day < (ledger.headDay ?? '')) return [];
      if (day !== ledger.headDay) { ledger.headDay = day; ledger.heads = 0; }
      const candidates = ledger.entries
        .filter(e => now - e.at > LIMITS.retentionDays * 86400_000)
        .sort((a, b) => (a.checkedAt ?? 0) - (b.checkedAt ?? 0))
        .slice(0, Math.max(0, LIMITS.headsDaily - (ledger.heads ?? 0)));
      ledger.heads = (ledger.heads ?? 0) + candidates.length;
      for (const e of candidates) e.checkedAt = now;
      await tx.put('ledger', ledger);
      return candidates;
    });
    const gone = new Set<string>();
    // Never delete. Failed or positive HEAD responses do not release quota.
    for (const e of candidates) {
      try { if (await this.env.BACKUPS.head(e.key) === null) gone.add(e.key); }
      catch { /* Retry within a later day's budget. */ }
    }
    if (gone.size) await this.ctx.storage.transaction(async tx => {
      const current = (await tx.get<Ledger>('ledger'))!;
      current.entries = current.entries.filter(e => !gone.has(e.key));
      await tx.put('ledger', current);
    });
    await this.notifyStale();
    return json({ released: gone.size });
  }
  private async notifyStale(): Promise<void> {
    if (!this.env.DISCORD_WEBHOOK_URL) return;
    const now = Date.now(), day = new Date(now).toISOString().slice(0, 10);
    const reason = await this.ctx.storage.transaction(async tx => {
      const ledger = await tx.get<Ledger>('ledger') ?? this.empty();
      ledger.monitoringSince ??= now;
      const stale = now - (ledger.lastSuccess ?? ledger.monitoringSince) > 30 * 3600_000;
      const full = ledger.entries.reduce((n, e) => n + e.bytes, 0) + LIMITS.object > LIMITS.stored || ledger.entries.length >= LIMITS.entries;
      const reason = stale ? '30時間以上バックアップの成功を確認できません。' : full ? '保存容量の上限に近づき、新規バックアップが停止する可能性があります。' : null;
      const send = reason && day > (ledger.alertDay ?? '');
      if (send) ledger.alertDay = day;
      await tx.put('ledger', ledger);
      return send ? reason : null;
    });
    if (reason) {
      try {
        const response = await fetch(this.env.DISCORD_WEBHOOK_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: `virtualCrypto: ${reason} Fly の virtualcrypto-backup を確認してください。`, allowed_mentions: { parse: [] } }),
          signal: AbortSignal.timeout(5000)
        });
        if (!response.ok) console.error('Backup notification failed:', response.status);
        await response.body?.cancel();
      } catch { console.error('Backup notification delivery failed'); }
    }
  }

}
