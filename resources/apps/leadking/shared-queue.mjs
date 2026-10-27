import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const DATA_DIR = process.env.LEADKING_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'LeadKingReplica');
const CONFIG_FILE = path.join(DATA_DIR, 'shared-queue-config.json');
const SESSION_FILE = path.join(DATA_DIR, 'shared-queue-session.json');
const WORKER_FILE = path.join(DATA_DIR, 'shared-queue-worker.json');
const LEASE_SECONDS = 900;

export class SharedLeadQueue {
  constructor() {
    this.config = null;
    this.session = null;
    this.workerId = null;
    this.workerName = os.hostname().slice(0, 80) || 'LeadKing PC';
  }
  async load() {
    try {
      const config = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
      this.config = this.validateConfig(config);
    } catch { this.config = null; }
    try {
      const worker = JSON.parse(await fs.readFile(WORKER_FILE, 'utf8'));
      if (typeof worker.workerId === 'string' && worker.workerId.length >= 8) this.workerId = worker.workerId;
      if (typeof worker.displayName === 'string' && worker.displayName.trim()) this.workerName = worker.displayName.trim().slice(0, 80);
    } catch { /* first launch on this device */ }
    if (!this.workerId) {
      this.workerId = randomUUID();
      await this.saveWorker();
    }
    // The password and refresh token are intentionally not persisted. Each desktop asks
    // the user to sign in again after restart.
  }
  validateConfig(config) {
    const url = String(config?.url || '').trim().replace(/\/$/, '');
    const anonKey = String(config?.anonKey || '').trim();
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('Enter a valid Supabase project URL.'); }
    if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.supabase.co') || !anonKey) {
      throw new Error('Use the HTTPS project URL ending in .supabase.co and its public anon/publishable key.');
    }
    return { url, anonKey };
  }
  configured() { return Boolean(this.config); }
  connected() { return Boolean(this.session?.accessToken && this.config); }
  async configure(config) {
    this.config = this.validateConfig(config);
    this.session = null;
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(CONFIG_FILE, JSON.stringify(this.config, null, 2), 'utf8');
    await fs.rm(SESSION_FILE, { force: true });
    return this.status();
  }
  async request(pathname, { method = 'GET', body, auth = false, retry = true, headers = {} } = {}) {
    if (!this.config) throw new Error('Configure the Supabase project URL and public anon key first.');
    const requestHeaders = { apikey: this.config.anonKey, Accept: 'application/json', ...headers };
    if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
    if (auth) {
      if (!this.session?.accessToken) throw new Error('Sign in to Supabase from the Shared queue card first.');
      requestHeaders.Authorization = `Bearer ${this.session.accessToken}`;
    } else requestHeaders.Authorization = `Bearer ${this.config.anonKey}`;
    const response = await fetch(`${this.config.url}${pathname}`, { method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (response.status === 401 && auth && retry && this.session?.refreshToken) {
      await this.refreshSession();
      return this.request(pathname, { method, body, auth, retry: false, headers });
    }
    if (!response.ok) {
      const detail = data?.msg || data?.message || data?.error_description || data?.error || `HTTP ${response.status}`;
      throw new Error(`Supabase request failed: ${String(detail).slice(0, 240)}`);
    }
    return data;
  }
  async signIn(email, password) {
    const data = await this.request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: String(email || '').trim(), password: String(password || '') } });
    if (!data?.access_token || !data?.user?.id) throw new Error('Supabase did not return a signed-in user session.');
    this.session = { accessToken: data.access_token, refreshToken: data.refresh_token, userId: data.user.id, email: data.user.email || String(email || '') };
    await this.registerWorker();
    return this.status();
  }
  async refreshSession() {
    if (!this.session?.refreshToken) throw new Error('Session expired. Sign in again.');
    const data = await this.request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', auth: false, body: { refresh_token: this.session.refreshToken } });
    if (!data?.access_token) throw new Error('Session expired. Sign in again.');
    this.session = { accessToken: data.access_token, refreshToken: data.refresh_token, userId: data.user.id, email: data.user.email || this.session.email };
  }
  signOut() { this.session = null; }
  async saveWorker() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(WORKER_FILE, JSON.stringify({ workerId: this.workerId, displayName: this.workerName }, null, 2), 'utf8');
  }
  async registerWorker(displayName = this.workerName) {
    if (!this.connected()) throw new Error('Sign in to Supabase first.');
    const name = String(displayName || '').trim().slice(0, 80);
    if (!name) throw new Error('Enter a name for this computer.');
    this.workerName = name;
    await this.saveWorker();
    await this.request('/rest/v1/rpc/leadking_register_worker', { method: 'POST', auth: true, body: { p_worker_id: this.workerId, p_display_name: this.workerName } });
    return this.status();
  }
  async assign(workerId, city, limit) {
    if (!this.connected()) throw new Error('Sign in to Supabase first.');
    const assigned = await this.request('/rest/v1/rpc/leadking_assign_work', {
      method: 'POST', auth: true,
      body: { p_worker_id: String(workerId || ''), p_city: city || null, p_limit: Math.max(1, Math.min(5000, Number(limit) || 100)) }
    });
    return Number(assigned || 0);
  }
  async status() {
    let counts = null;
    let workers = [];
    let cities = [];
    if (this.connected()) {
      await this.request('/rest/v1/rpc/leadking_register_worker', { method: 'POST', auth: true, body: { p_worker_id: this.workerId, p_display_name: this.workerName } });
      [counts, workers, cities] = await Promise.all([
        this.request('/rest/v1/rpc/leadking_queue_counts', { method: 'POST', auth: true, body: {} }),
        this.request('/rest/v1/rpc/leadking_list_workers', { method: 'POST', auth: true, body: {} }),
        this.request('/rest/v1/rpc/leadking_available_cities', { method: 'POST', auth: true, body: {} })
      ]);
    }
    const item = Array.isArray(counts) ? counts[0] : counts;
    return {
      configured: this.configured(), connected: this.connected(), email: this.session?.email || '',
      device: { workerId: this.workerId, displayName: this.workerName },
      workers: workers || [], cities: cities || [],
      counts: item ? { pending: Number(item.pending || 0), leased: Number(item.leased || 0), complete: Number(item.complete || 0) } : null
    };
  }
  async enqueueRows(rows) {
    if (!this.connected()) throw new Error('Connect your Supabase account first.');
    rows = rows.filter(row => row.status === 'pending' && row.website && (row.sourceIdentity || row.id));
    const batchSize = 100;
    let attempted = 0;
    for (let offset = 0; offset < rows.length; offset += batchSize) {
      const batch = rows.slice(offset, offset + batchSize).map(row => ({
        owner_id: this.session.userId,
        source_identity: row.sourceIdentity || row.id,
        payload: {
          id: row.id, sourceIdentity: row.sourceIdentity || row.id, canonicalLeadKey: row.canonicalLeadKey,
          name: row.name, website: row.website, city: row.city, country: row.country, address: row.address,
          sourceUrl: row.sourceUrl, sourceFile: row.sourceFile, sourceRow: row.sourceRow,
          status: row.status, sourceDisposition: row.sourceDisposition, importedAt: row.importedAt,
          candidates: [], pagesVisited: [], lastError: ''
        },
        work_state: 'pending', result: null
      }));
      await this.request('/rest/v1/leadking_work_items?on_conflict=owner_id,source_identity', {
        method: 'POST', auth: true, body: batch,
        headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }
      });
      attempted += batch.length;
    }
    return { attempted };
  }
  async syncCrawlerRecords(records) {
    if (!this.connected()) throw new Error('Connect your Supabase account first.');
    const batchSize = 100;
    let attempted = 0;
    for (let offset = 0; offset < records.length; offset += batchSize) {
      const batch = records.slice(offset, offset + batchSize).filter(record =>
        ['business_lead', 'therapist_research'].includes(record?.recordKind)
        && typeof record.recordKey === 'string' && record.recordKey.length > 0
        && record.payload && typeof record.payload === 'object'
      ).map(record => ({
        owner_id: this.session.userId,
        record_key: record.recordKey,
        record_kind: record.recordKind,
        run_id: record.runId ? String(record.runId).slice(0, 160) : null,
        payload: record.payload,
        updated_at: new Date().toISOString()
      }));
      if (!batch.length) continue;
      await this.request('/rest/v1/leadking_crawl_records?on_conflict=owner_id,record_key', {
        method: 'POST', auth: true, body: batch,
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }
      });
      attempted += batch.length;
    }
    return { attempted };
  }
  async pullCrawlerRecords(onRecords) {
    if (!this.connected()) throw new Error('Connect your Supabase account first.');
    let offset = 0; let synced = 0;
    while (true) {
      const params = new URLSearchParams({ select: 'record_key,record_kind,run_id,payload', order: 'record_key.asc', limit: '500', offset: String(offset) });
      const rows = await this.request(`/rest/v1/leadking_crawl_records?${params}`, { auth: true, headers: { Prefer: 'count=none' } });
      for (const item of rows || []) {
        if (!item.record_key || !item.record_kind || !item.payload) continue;
        await onRecords(item);
        synced++;
      }
      if (!rows || rows.length < 500) break;
      offset += rows.length;
    }
    return { synced };
  }
  async claim() {
    const data = await this.request('/rest/v1/rpc/leadking_claim_work', { method: 'POST', auth: true, body: { p_worker_id: this.workerId, p_lease_seconds: LEASE_SECONDS } });
    const item = Array.isArray(data) ? data[0] : data;
    return item || null;
  }
  async renew(item) {
    const ok = await this.request('/rest/v1/rpc/leadking_renew_work', { method: 'POST', auth: true, body: { p_source_identity: item.source_identity, p_lease_token: item.lease_token, p_lease_seconds: LEASE_SECONDS } });
    return ok === true;
  }
  async complete(item, result) {
    const ok = await this.request('/rest/v1/rpc/leadking_complete_work', { method: 'POST', auth: true, body: { p_source_identity: item.source_identity, p_lease_token: item.lease_token, p_result: result } });
    return ok === true;
  }
  async release(item) {
    try { await this.request('/rest/v1/rpc/leadking_release_work', { method: 'POST', auth: true, body: { p_source_identity: item.source_identity, p_lease_token: item.lease_token } }); } catch { /* lease expiry makes it available later */ }
  }
  async pullCompleted(onRows) {
    if (!this.connected()) throw new Error('Connect your Supabase account first.');
    let offset = 0; let synced = 0;
    while (true) {
      const params = new URLSearchParams({ select: 'result', work_state: 'eq.complete', result: 'not.is.null', order: 'updated_at.asc', limit: '500', offset: String(offset) });
      const rows = await this.request(`/rest/v1/leadking_work_items?${params}`, { auth: true, headers: { Prefer: 'count=none' } });
      for (const item of rows || []) {
        if (item.result?.id && item.result?.sourceIdentity) { await onRows(item.result); synced++; }
      }
      if (!rows || rows.length < 500) break;
      offset += rows.length;
    }
    return { synced };
  }
}

