// One logged-in XHS account is shared by the bot personas. Queue foreground
// work across personas instead of asking the model to retry a concurrency error.
export class SerialExecutor {
    constructor(maxWaiting = 64) { this.maxWaiting = maxWaiting; this.running = false; this.waiting = []; }
    acquire(signal) {
        signal?.throwIfAborted();
        if (this.running && this.waiting.length >= this.maxWaiting) throw new Error('xhs_queue_full');
        return new Promise((resolve, reject) => {
            const entry = { signal, resolve, reject, abort: undefined };
            entry.abort = () => {
                const index = this.waiting.indexOf(entry);
                if (index >= 0) this.waiting.splice(index, 1);
                signal?.removeEventListener('abort', entry.abort);
                reject(signal.reason);
            };
            signal?.addEventListener('abort', entry.abort, { once: true });
            this.waiting.push(entry);
            this.next();
        });
    }
    next() {
        if (this.running) return;
        const entry = this.waiting.shift();
        if (!entry) return;
        entry.signal?.removeEventListener('abort', entry.abort);
        if (entry.signal?.aborted) { entry.reject(entry.signal.reason); this.next(); return; }
        this.running = true;
        let released = false;
        entry.resolve(() => {
            if (released) return;
            released = true;
            this.running = false;
            this.next();
        });
    }
}
