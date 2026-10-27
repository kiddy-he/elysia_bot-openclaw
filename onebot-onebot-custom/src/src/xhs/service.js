import { randomUUID } from 'node:crypto';
import { join, resolve, basename } from 'node:path';
import { rename, unlink, readdir, stat, lstat, readFile, copyFile } from 'node:fs/promises';
import { privateDir } from './infra/files.js';
import { SessionStore } from './infra/session.js';
import { Store, digest } from './infra/store.js';
import { PublicDownloader } from './infra/network.js';
import { validateImage, validateVideo, sha256, TransferBudget } from './infra/media.js';
import { HttpBackend } from './backends/http.js';
import { normalizeSearch, normalizeNote, imageCandidates, videoVariants, checkConstraints, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from './domain/notes.js';
import { noteTarget, isShortUrl, canonicalUrl } from './domain/urls.js';
import { validate } from './schemas.js';
import { XhsError, fail, checkAbort, safeError, signalFor, TERMINAL } from './errors.js';
export class XhsService {
  static async create(options = {}) {
    const root = resolve(options.dataDir ?? './data/xhs'); await privateDir(root); await privateDir(join(root, 'media'));
    const store = new Store(root, options), sessions = new SessionStore(root);
    let backend = options.backend;
    if (!backend || backend === 'http') backend = new HttpBackend({ sessionStore: sessions });
    if (backend === 'interactive') {
      const { InteractiveBackend } = await import('./backends/interactive.js');
      backend = new InteractiveBackend({ root, sessionStore: sessions, executablePath: options.executablePath,
        chromiumSandbox: options.chromiumSandbox ?? true, interactionPort: options.interactionPort ?? 0, interactionPublicOrigin: options.interactionPublicOrigin, headed: options.headed ?? false });
    }
    if (backend === 'browser') { const { BrowserBackend } = await import('./browser/backend.js'); backend = new BrowserBackend({ root, executablePath: options.executablePath, chromiumSandbox: options.chromiumSandbox ?? true, directConnection: options.directConnection ?? true, interactiveLogin: options.interactiveLogin ?? false, interactionPort: options.interactionPort ?? 0, interactionPublicOrigin: options.interactionPublicOrigin, headed: options.headed ?? false }); }
    return new XhsService({ ...options, root, store, sessions, backend });
  }
  constructor({ root, store, sessions, backend, downloader = new PublicDownloader(), authorize = async () => true, authorizeJob = async () => true, onEvent, maxSearches = 4, requestTimeoutMs = 85000, jobTimeoutMs = 180000, jobConcurrency = 2, maxVideoBytes = MAX_VIDEO_BYTES, completeAlbums = false }) {
    Object.assign(this, { root, store, sessions, backend, downloader, authorize, authorizeJob, onEvent, maxSearches, requestTimeoutMs, jobTimeoutMs, jobConcurrency, maxVideoBytes, completeAlbums });
    this.owner = randomUUID(); this.active = new Map(); this.foreground = new Map(); this.closed = false; this.loop = null;
    this.store.db.exec('CREATE TABLE IF NOT EXISTS xhs_media_cache_sources (key TEXT PRIMARY KEY, artifact TEXT NOT NULL, expires INTEGER NOT NULL)');
  }
  context(context) {
    if (!context || ['accountId', 'scope', 'actorId', 'requestId'].some(k => typeof context[k] !== 'string' || !context[k].trim() || context[k].length > 256)) fail('trusted_context_required');
    if (context.generation !== undefined && !(typeof context.generation === 'string' && context.generation.length <= 128 || Number.isSafeInteger(context.generation))) fail('trusted_context_required');
    if (context.expiresAt !== undefined && (!Number.isFinite(context.expiresAt) || context.expiresAt <= Date.now())) fail('authorization_expired');
    return digest(['v1', context.accountId, context.scope, context.actorId, context.requestId, context.generation ?? 0]);
  }
  async allowed(context, operation, signal) {
    checkAbort(signal);
    const key = this.context(context);
    if (this.store.terminal(key) === 'authorization_revoked' || !await this.authorize(context, operation)) fail('authorization_revoked');
    checkAbort(signal);
    this.context(context);
    if (this.store.terminal(key) === 'authorization_revoked') fail('authorization_revoked');
  }
  execute(operation, input = {}, context, options = {}) {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
    const pending = this._execute(operation, input, context, { ...options, signal });
    this.foreground.set(pending, controller);
    return pending.finally(() => this.foreground.delete(pending));
  }
  async _execute(operation, input = {}, context, options = {}) {
    const callId = options.callId ?? randomUUID();
    try {
      if (this.closed) fail('service_closed');
      const params = validate(operation, input), key = this.context(context);
      const signal = signalFor(options.signal, operation === 'login' ? 305000 : this.requestTimeoutMs);
      await this.allowed(context, operation, signal); this.store.request(key);
      if (this.store.terminal(key) === 'authorization_revoked') fail('authorization_revoked');
      let data;
      if (['login', 'status'].includes(operation)) {
        if (context.operator !== true) fail('operator_required');
        data = await this.site(key, () => this.backend[operation]({ signal, onProgress: options.onProgress, beforeCommit: () => this.allowed(context, operation, signal) }), { operator: true, ttl: operation === 'login' ? 310000 : 100000 });
      } else if (operation === 'search') {
        const args = { ...params, query: params.query.trim().replace(/^#+/u, ''), limit: params.limit ?? 6, sort: params.sort ?? 'relevance', search_mode: params.search_mode ?? 'keyword' }; if (!args.query) fail('invalid_request');
        this.ensureSite(key);
        data = this.store.cacheGet(key, 'search', args);
        if (data) data = { ...data, cached: true };
        else data = await this.site(key, async () => {
          // Recheck inside the cross-process lock to avoid charging duplicate concurrent calls.
          const cached = this.store.cacheGet(key, 'search', args); if (cached) return { ...cached, cached: true };
          this.store.searchAttempt(key, this.maxSearches);
          const rows = await this.backend.search(args, { signal });
          await this.allowed(context, operation, signal);
          const result = { ...normalizeSearch(rows, args), search_mode: args.search_mode, query: args.query, semantic_note: args.search_mode === 'tag' ? 'tag mode uses the site keyword search endpoint; exact topic-only filtering is not independently verified' : null }; this.store.cachePut(key, 'search', args, result); return result;
        });
      } else if (operation === 'comments') {
        this.ensureSite(key);
        const { note, source_url } = await this.note(key, params.ref_id, signal, context);
        const target = noteTarget(source_url), cursorKind = `comments:${target.id}:${params.parent_comment_id ?? ''}`;
        let cursor = '';
        if (params.cursor) cursor = this.store.getCursor(key, params.cursor, cursorKind).cursor;
        if (typeof this.backend.comments !== 'function') fail('capability_unavailable', { capability: 'comments' });
        const result = await this.site(key, () => this.backend.comments({ note_id: target.id, xsec_token: target.token, cursor, parent_comment_id: params.parent_comment_id, limit: params.limit ?? 20 }, { signal }));
        await this.allowed(context, operation, signal);
        data = { post_id: target.id, source_url, parent_comment_id: params.parent_comment_id ?? null, comments: result.comments.slice(0, params.limit ?? 20), next_cursor: result.hasMore && result.cursor ? this.store.putCursor(key, cursorKind, { cursor: result.cursor }) : null, has_more: result.hasMore, observed_at: new Date().toISOString(), trust: 'untrusted_external_sources' };
      } else if (operation === 'profile') {
        this.ensureSite(key);
        if (typeof this.backend.profile !== 'function') fail('capability_unavailable', { capability: 'profile' });
        data = await this.site(key, () => this.backend.profile(params.user_id, { signal }));
        if (params.include_posts) {
          if (typeof this.backend.userPosted !== 'function') fail('capability_unavailable', { capability: 'profile_posts' });
          const kind = `profile:${params.user_id}`, cursor = params.posts_cursor ? this.store.getCursor(key, params.posts_cursor, kind).cursor : '';
          const posted = await this.site(key, () => this.backend.userPosted({ user_id: params.user_id, cursor, limit: params.posts_limit ?? 10 }, { signal }));
          data = { ...data, posts: posted.notes.slice(0, params.posts_limit ?? 10), posts_next_cursor: posted.hasMore && posted.cursor ? this.store.putCursor(key, kind, { cursor: posted.cursor }) : null, posts_has_more: posted.hasMore };
        }
      } else if (operation === 'inspect') {
        const resources = [];
        for (const source of params.ref_ids) {
          try { const { note, source_url } = await this.note(key, source, signal, context); const post = normalizeNote(note, source_url);
            resources.push({ ...post, media_count: note.type === 'normal' ? imageCandidates(note, source_url).images.length : 1, status: 'ok' });
          } catch (e) { resources.push({ source_url: source, status: 'failed', error: safeError(e) }); if (TERMINAL.has(e.code)) break; }
        }
        data = { resources, partial: resources.length < params.ref_ids.length || resources.some(r => r.status !== 'ok') };
        if (!resources.some(r => r.status === 'ok')) fail(resources[0]?.error?.code ?? 'inspection_failed', { resources });
      } else if (operation === 'list_images') {
        const { note, source_url } = await this.note(key, params.ref_id, signal, context);
        const result = imageCandidates(note, source_url), offset = params.offset ?? 0;
        const images = result.images.map(v => ({ image_id: this.store.candidate(key, v), media_index: v.media_index, role: v.role, quality: v.quality, width: v.width, height: v.height }));
        data = { ...result.post, images: images.slice(offset, offset + 20), total: images.length, next_offset: offset + 20 < images.length ? offset + 20 : null, declared_image_count: result.declared_image_count, candidate_limit_reached: result.candidate_limit_reached };
      } else if (operation === 'download_images' || operation === 'download_video') {
        this.ensureSite(key);
        if (operation === 'download_images') {
          if (this.completeAlbums) {
            // The supplied handles select posts; never download only a subset of an album.
            const selected = new Map(params.image_ids.map(id => { const item=this.store.getCandidate(key,id); return [item.post.post_id,item.post]; }));
            const full=[],albumTotals={};
            for (const post of selected.values()) {
              const {note,source_url}=await this.note(key,post.source_url,signal,context);
              const album=imageCandidates(note,source_url);
              if (album.candidate_limit_reached || album.images.length!==album.declared_image_count) fail('album_incomplete');
              albumTotals[post.post_id]=album.images.length;
              for (const image of album.images) full.push(this.store.candidate(key,{...image,album_total:album.images.length}));
            }
            if (full.length>160) fail('album_batch_limit');
            params.image_ids=full;params.album_totals=albumTotals;
          }
          for (const id of params.image_ids) checkConstraints(this.store.getCandidate(key, id).post, params.constraints);
        }
        else { const { note, source_url } = await this.note(key, params.ref_id, signal, context); checkConstraints(normalizeNote(note, source_url), params.constraints); }
        if (params.quality === 'original_only') fail('original_quality_unverified');
        await this.allowed(context, operation, signal);
        data = this.store.enqueue(key, operation, { ...params, quality: params.quality ?? 'best_available', constraints: params.constraints ?? {}, origin: this.safeOrigin(context) });
      } else if (operation === 'job_status') data = this.store.job(key, params.job_id);
      else if (operation === 'cancel_job') { data = this.store.cancel(key, params.job_id); this.active.get(params.job_id)?.abort(); }
      else if (operation === 'artifact') data = await this.artifact(key, params.artifact_id);
      await this.allowed(context, operation, signal);
      return { version: 1, call_id: callId, operation, ok: true, status: data?.state === 'queued' || data?.state === 'running' ? 'accepted' : 'ok', data, error: null };
    } catch (e) { return { version: 1, call_id: callId, operation, ok: false, status: ['cancelled', 'authorization_revoked'].includes(e.code) ? 'cancelled' : 'failed', data: null, error: safeError(e) }; }
  }
  safeOrigin(ctx) { return Object.fromEntries(['accountId', 'scope', 'actorId', 'requestId', 'generation', 'expiresAt'].filter(k => ctx[k] !== undefined).map(k => [k, ctx[k]])); }
  ensureSite(key) { const terminal = this.store.terminal(key); if (terminal) fail(terminal, { stopped_in_request: true }); }
  async site(key, fn, { operator = false, ttl = 100000 } = {}) {
    if (!operator) this.ensureSite(key);
    const release = this.store.lock('site-account', ttl);
    try { if (!operator) this.ensureSite(key); return await fn(); }
    catch (e) { if (TERMINAL.has(e.code)) this.store.stop(key, e.code); throw e; }
    finally { release(); }
  }
  async note(key, source, signal, context) {
    this.ensureSite(key);
    if (isShortUrl(source)) source = await this.downloader.resolveNote(source, { signal });
    const { id, token } = noteTarget(source); source = canonicalUrl(id, token);
    const cached = this.store.cacheGet(key, 'note', { source }); if (cached) return cached;
    return this.site(key, async () => {
      const old = this.store.cacheGet(key, 'note', { source }); if (old) return old;
      const result = await this.backend.inspect(source, { signal }); checkAbort(signal);
      normalizeNote(result.note, source); if (noteTarget(result.source_url).id !== id) fail('identity_mismatch');
      if (context) await this.allowed(context, 'inspect', signal);
      this.store.cachePut(key, 'note', { source }, result);if(this.backend.noteCacheTtlMs)this.store.db.prepare('UPDATE cache SET expires=? WHERE key=?').run(Date.now()+this.backend.noteCacheTtlMs,digest([key,'note',{source}])); return result;
    });
  }
  async importSession(session, context) {
    if (this.closed) fail('service_closed');
    const key = this.context(context); if (context.operator !== true) fail('operator_required');
    await this.allowed(context, 'import_session'); this.store.request(key);
    const release = this.store.lock('site-account');
    try { return await this.sessions.save(session, { beforeCommit: () => this.allowed(context, 'import_session') }); } finally { release(); }
  }
  async runPending({ signal } = {}) {
    if (this.closed) fail('service_closed');
    const run = async () => {
      while (!signal?.aborted && !this.closed) {
        const row = this.store.claim(this.owner); if (!row) break;
        await this.runJob(row, signal);
      }
    };
    await Promise.all(Array.from({ length: this.jobConcurrency }, run));
  }
  async runJob(row, parentSignal) {
    const ctrl = new AbortController(); this.active.set(row.id, ctrl);
    const signal = signalFor(AbortSignal.any([ctrl.signal, ...(parentSignal ? [parentSignal] : [])]), this.jobTimeoutMs);
    const tick = setInterval(() => {
      if (!this.store.jobActive(row.id, row.owner)) ctrl.abort(); else this.store.heartbeat(row.id, row.owner);
    }, 500); tick.unref();
    const artifacts = [];
    const guard = async () => {
      checkAbort(signal);
      if (!this.store.jobActive(row.id, row.owner)) fail('cancelled');
      this.store.request(row.request); this.ensureSite(row.request);
      const origin = row.params.origin;
      if (origin.expiresAt !== undefined && origin.expiresAt <= Date.now() || !await this.authorizeJob(origin, row.operation) || !await this.authorize(origin, row.operation)) fail('authorization_revoked');
      checkAbort(signal);
      this.context(origin); this.ensureSite(row.request);
      if (!this.store.jobActive(row.id, row.owner)) fail('cancelled');
    };
    try {
      await guard();
      const result = row.operation === 'download_images' ? await this.downloadImages(row, { signal, guard, artifacts }) : await this.downloadVideo(row, { signal, guard, artifacts });
      await guard();
      const committed = this.store.finish(row, result.failures?.length ? artifacts.length ? 'partial' : 'failed' : 'succeeded', result, null);
      if (!committed) for (const artifact of artifacts) await this.removeArtifact(artifact.artifact_id);
    } catch (e) {
      if (TERMINAL.has(e.code)) this.store.stop(row.request, e.code);
      for (const artifact of artifacts) await this.removeArtifact(artifact.artifact_id);
      // Downloads have no external platform write; recovery may safely resume queued work.
      this.store.finish(row, ['cancelled', 'authorization_revoked'].includes(e.code) ? 'cancelled' : 'failed', null, safeError(e));
    } finally {
      clearInterval(tick); this.active.delete(row.id);
      try { await this.onEvent?.({ type: 'job_finished', ...this.store.job(row.request, row.id) }); } catch {}
    }
  }
  async downloadImages(row, { signal, guard, artifacts }) {
    const failures = [], budget = new TransferBudget((this.completeAlbums ? 100 : 32) * 1024 ** 2, this.completeAlbums ? 180 : 48);
    for (const id of row.params.image_ids) {
      await guard();
      try {
        const item = this.store.getCandidate(row.request, id); checkConstraints(item.post, row.params.constraints);
        const saved = await this.downloadFile(row.request, item.url, item.post.source_url, 'image', { signal, guard, budget, metadata: { post: item.post, media_index: item.media_index, ...(row.params.album_totals?.[item.post.post_id] ? {album_total:row.params.album_totals[item.post.post_id]} : {}), quality: item.quality } });
        artifacts.push(saved);
      } catch (e) { if (signal.aborted || ['authorization_revoked', 'cancelled'].includes(e.code) || TERMINAL.has(e.code)) throw e; failures.push({ image_id: id, error: safeError(e) }); }
    }
    return { artifacts, failures, delivery_status: 'not_sent' };
  }
  async downloadVideo(row, { signal, guard, artifacts }) {
    const { note, source_url } = await this.note(row.request, row.params.ref_id, signal, row.params.origin);
    const post = normalizeNote(note, source_url); checkConstraints(post, row.params.constraints);
    const variants = videoVariants(note, source_url, row.params).filter(v => v.estimated_bytes <= this.maxVideoBytes);
    if (!variants.length) fail('video_delivery_size_limit'); const budget = new TransferBudget(); let last;
    const diagnostics = [];
    for (const variant of variants) for (const url of variant.urls) {
      await guard();
      try {
        const saved = await this.downloadFile(row.request, url, source_url, 'video', { signal, guard, budget, declared: variant.declared_bytes, metadata: { post, quality: variant.quality, fallback_reason: variant.fallback_reason } });
        artifacts.push(saved); return { artifacts, failures: [], attempts: diagnostics, delivery_status: 'not_sent' };
      } catch (e) {
        last = e; diagnostics.push({ error: safeError(e), width: variant.width, height: variant.height });
        if (signal.aborted || ['authorization_revoked', 'cancelled'].includes(e.code) || TERMINAL.has(e.code)) throw e;
      }
    }
    throw last ?? new XhsError('no_compatible_video');
  }
  async downloadFile(request, url, referer, kind, { signal, guard, budget, declared = 0, metadata }) {
    await this.cleanup();
    const release = this.store.reserve(kind === 'image' ? MAX_IMAGE_BYTES : this.maxVideoBytes);
    const id = 'art-' + randomUUID(), tmp = join(this.root, 'media', `.part-${randomUUID()}`);
    let final;
    try {
      await guard();
      const cacheKey=digest([kind,url]);
      const cached=this.store.db.prepare('SELECT a.file,a.data FROM xhs_media_cache_sources c JOIN artifacts a ON a.id=c.artifact WHERE c.key=? AND c.expires>? AND a.expires>?').get(cacheKey,Date.now(),Date.now());
      let reused=false;
      if(cached){
        const source=join(this.root,'media',basename(cached.file)),data=JSON.parse(cached.data),info=await lstat(source).catch(()=>null);
        if(info?.isFile()&&!info.isSymbolicLink()&&info.size===data.bytes&&info.size<=(kind==='image'?MAX_IMAGE_BYTES:this.maxVideoBytes)&&await sha256(source)===data.sha256){
          await copyFile(source,tmp);budget?.charge(info.size);reused=true;
        }
      }
      let downloaded=reused?{bytes:(await stat(tmp)).size}:null;
      if(!reused)for(let attempt=0;attempt<2;attempt++){
        await guard();
        try{downloaded=await this.downloader.get(url,{signal,maxBytes:kind==='image'?MAX_IMAGE_BYTES:this.maxVideoBytes,output:tmp,referer,timeoutMs:kind==='image'?30000:90000,budget});break;}
        catch(error){
          const transient=['download_failed','dns_failed','incomplete_download','deadline_exceeded'].includes(error.code)||error.code==='download_http_error'&&error.details?.status>=500;
          if(attempt||!transient||signal.aborted)throw error;
          await unlink(tmp).catch(()=>{});await guard();
        }
      }
      if (declared && downloaded.bytes !== declared) fail('incomplete_download');
      const info = kind === 'image' ? await validateImage(tmp, signal) : await validateVideo(tmp, signal);
      const hash = await sha256(tmp); await guard();
      const data = { artifact_id: id, kind, ...info, sha256: hash, ...metadata, created_at: new Date().toISOString(), delivery_status: 'not_sent',...(reused?{download_cache_hit:true}:{}) };
      const extension = kind === 'video' ? 'mp4' : info.format === 'jpeg' ? 'jpg' : info.format;
      const file = `${id}.${extension}`; final = join(this.root, 'media', file);
      await rename(tmp, final); await guard(); this.store.saveArtifact(request, id, file, data);this.store.db.prepare('INSERT OR REPLACE INTO xhs_media_cache_sources VALUES(?,?,?)').run(cacheKey,id,Date.now()+30*60000); return data;
    } catch (e) { if (final) await unlink(final).catch(() => {}); throw e; }
    finally { release(); await unlink(tmp).catch(() => {}); }
  }
  async artifact(request, id) {
    const row = this.store.artifact(request, id), path = join(this.root, 'media', basename(row.file));
    const info = await lstat(path).catch(() => null);
    if (info?.isSymbolicLink() || !info?.isFile() || info.size !== row.bytes || await sha256(path) !== row.metadata.sha256) fail('artifact_integrity_failed');
    this.store.db.prepare('UPDATE artifacts SET lease=? WHERE id=?').run(Date.now() + 1200000, id);
    return { ...row.metadata, path, lease_until: new Date(Date.now() + 1200000).toISOString() };
  }
  async removeArtifact(id) {
    const row = this.store.db.prepare('SELECT file FROM artifacts WHERE id=?').get(id);
    if (row) { await unlink(join(this.root, 'media', basename(row.file))).catch(() => {}); this.store.db.prepare('DELETE FROM artifacts WHERE id=?').run(id); }
  }
  async cleanup() {
    let release; try { release = this.store.lock('cache-cleanup', 30000); } catch (e) { if (e.code === 'crawler_busy') return; throw e; }
    try {
      const now = Date.now();
      for (const row of this.store.db.prepare('SELECT id FROM artifacts WHERE expires<? AND lease<?').all(now, now)) await this.removeArtifact(row.id);
      this.store.db.prepare('DELETE FROM cache WHERE expires<?').run(now);
      this.store.db.prepare('DELETE FROM xhs_media_cache_sources WHERE expires<? OR artifact NOT IN (SELECT id FROM artifacts)').run(now);
      this.store.db.prepare('DELETE FROM candidates WHERE expires<?').run(now);
      this.store.db.prepare('DELETE FROM events WHERE created<?').run(now - this.store.ttlMs);
      this.store.db.prepare("DELETE FROM jobs WHERE expires<? AND state!='running'").run(now);
      const known = new Set(this.store.db.prepare('SELECT file FROM artifacts').all().map(r => r.file));
      for (const file of await readdir(join(this.root, 'media'))) if (!known.has(file)) {
        const path = join(this.root, 'media', file), info = await stat(path).catch(() => null);
        if (info && info.mtimeMs < now - 3600000) await unlink(path).catch(() => {});
      }
    } finally { release(); }
  }
  revoke(context) { const key = this.context(context); this.store.request(key); this.store.stop(key, 'authorization_revoked'); this.store.db.prepare("UPDATE jobs SET state='cancelled',error=? WHERE request=? AND state IN ('queued','running')").run(JSON.stringify({ code: 'authorization_revoked' }), key); }
  start({ intervalMs = 1000 } = {}) {
    if (this.loop) return;
    let busy = false;
    this.loop = setInterval(async () => { if (busy || this.closed) return; busy = true; try { await this.runPending(); } catch { /* Job failures are persisted; a scheduler failure must not crash the host. */ } finally { busy = false; } }, intervalMs);
    this.loop.unref();
  }
  async close() {
    if (this.closed) return;
    clearInterval(this.loop); this.closed = true;
    for (const ctrl of this.active.values()) ctrl.abort();
    for (const ctrl of this.foreground.values()) ctrl.abort();
    await Promise.allSettled([...this.foreground.keys()]);
    while (this.active.size) await new Promise(r => setTimeout(r, 10));
    await this.backend.close?.(); this.store.close();
  }
}
