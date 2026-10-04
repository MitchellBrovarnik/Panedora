const { DiscordRpc } = require('./discord-rpc');

const MIN_UPDATE_MS = 5000;
const PLAYBACK_TIMEOUT_MS = 45000;
const validClientId = value => typeof value === 'string' && /^[1-9]\d{16,19}$/.test(value);
const text = (value, fallback) => (typeof value === 'string' && value.trim() || fallback)
    .slice(0, 128).replace(/[\uD800-\uDBFF]$/, '').padEnd(2, ' ');

function artworkUrl(value) {
    try {
        const url = new URL(value);
        if (url.protocol === 'https:' && !url.username && !url.password && url.href.length <= 2048) return url.href;
    } catch {}
    return null;
}

class DiscordPresence {
    constructor({ clientId, enabled = false, onStatus = () => {}, rpc,
        now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
        this.configured = validClientId(clientId);
        this.enabled = enabled === true;
        this.onStatus = onStatus;
        this.rpc = rpc || new DiscordRpc({ clientId });
        this.now = now;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.player = null;
        this.activity = null;
        this.anchor = null;
        this.retryDelay = 30000;
        this.lastSentAt = -Infinity;
        this.sentKey = null;
        this.generation = 0;
        this.connecting = false;
        this.sending = false;
        this.disposed = false;
        this.status = '';
        this.rpc.on('disconnect', () => this.failed('unavailable'));
        this.refresh();
    }

    getStatus() {
        return { enabled: this.enabled, configured: this.configured, status: this.status };
    }

    setStatus(status) {
        this.status = status;
        const key = JSON.stringify(this.getStatus());
        if (key === this.statusKey) return;
        this.statusKey = key;
        this.onStatus(this.getStatus());
    }

    setEnabled(enabled) {
        this.enabled = enabled === true;
        this.retryDelay = 30000;
        this.refresh();
        return this.getStatus();
    }

    setPlayerState(state) {
        const changed = !state || state.trackToken !== this.player?.trackToken ||
            state.playbackGeneration !== this.player?.playbackGeneration || state.audioURL !== this.player?.audioURL;
        this.player = state;
        if (changed || !state.isPlaying || state.streamBlocked || state.pausePlayback || state.stationLoading) {
            this.invalidatePlayback();
        }
    }

    invalidatePlayback() {
        this.activity = null;
        this.anchor = null;
        this.cancelTimer('playbackTimer');
        this.refresh();
    }

    reportPlayback(report) {
        const state = this.player;
        // Use only metadata held by main; renderer reports cannot publish arbitrary songs or URLs.
        if (!state?.trackToken || !state.audioURL || !state.isPlaying || state.streamBlocked || state.stationLoading ||
            !report || report.trackToken !== state.trackToken || report.playbackGeneration !== state.playbackGeneration ||
            typeof report.playing !== 'boolean') return false;
        if (!report.playing) { this.invalidatePlayback(); return true; }
        if (!Number.isFinite(report.position) || report.position < 0 || report.position > 86400 ||
            !Number.isFinite(report.duration) || report.duration < 0 || report.duration > 86400) return false;
        const duration = report.duration || (Number.isFinite(state.duration) ? state.duration : 0);
        const position = duration > 0 ? Math.min(report.position, duration) : report.position;
        const start = Math.round(this.now() - position * 1000);
        // Normal progress reports should not cause a Discord write every few seconds.
        // Seek/replay/resume and a real buffering delay move the timestamp anchor.
        if (this.anchor === null || Math.abs(start - this.anchor) > 2000) this.anchor = start;
        const activity = { type: 2, details: text(state.track, 'Unknown Track'), state: text(state.artist, 'Unknown Artist') };
        const cover = artworkUrl(state.coverArt);
        if (cover) activity.assets = { large_image: cover, large_text: text(state.album, state.track || 'Panedora') };
        if (duration > 0) activity.timestamps = { start: this.anchor, end: Math.round(this.anchor + duration * 1000) };
        this.activity = activity;
        this.cancelTimer('playbackTimer');
        this.playbackTimer = this.timer(() => this.invalidatePlayback(), PLAYBACK_TIMEOUT_MS);
        this.refresh();
        return true;
    }

    timer(callback, delay) {
        const timer = this.setTimer(callback, delay);
        timer?.unref?.();
        return timer;
    }

    cancelTimer(name) {
        if (this[name] != null) this.clearTimer(this[name]);
        this[name] = null;
    }

    disconnect() {
        this.generation++;
        this.cancelTimer('retryTimer');
        this.cancelTimer('sendTimer');
        this.connecting = this.sending = false;
        this.sentKey = null;
        this.rpc.close();
    }

    refresh() {
        if (this.disposed) return;
        if (!this.enabled || !this.configured || !this.activity) {
            this.disconnect();
            this.setStatus(!this.configured ? 'unconfigured' : !this.enabled ? 'disabled' : 'idle');
            return;
        }
        if (this.retryTimer || this.connecting) return;
        if (!this.rpc.ready) {
            this.connecting = true;
            const generation = this.generation;
            this.setStatus('connecting');
            Promise.resolve().then(() => {
                if (generation !== this.generation || this.disposed) return false;
                return this.rpc.connect();
            }).then(connected => {
                if (generation !== this.generation || this.disposed) return;
                this.connecting = false;
                if (!connected) return this.failed('unavailable');
                this.flush();
            }).catch(() => {
                if (generation === this.generation && !this.disposed) this.failed('unavailable');
            });
        } else this.flush();
    }

    failed(status) {
        if (this.disposed) return;
        this.disconnect();
        if (!this.enabled || !this.activity) return this.refresh();
        this.setStatus(status);
        this.retryTimer = this.timer(() => { this.retryTimer = null; this.refresh(); }, this.retryDelay);
        this.retryDelay = Math.min(300000, this.retryDelay * 2);
    }

    flush() {
        if (this.disposed || !this.activity || this.sending || this.sendTimer || !this.rpc.ready) return;
        const key = JSON.stringify(this.activity);
        if (key === this.sentKey) return;
        const delay = MIN_UPDATE_MS - (this.now() - this.lastSentAt);
        if (delay > 0) {
            this.sendTimer = this.timer(() => { this.sendTimer = null; this.flush(); }, delay);
            return;
        }
        const generation = this.generation;
        this.sending = true;
        this.lastSentAt = this.now();
        this.rpc.setActivity(this.activity).then(() => {
            if (generation !== this.generation || this.disposed) return;
            this.sending = false;
            this.sentKey = key;
            this.retryDelay = 30000;
            this.setStatus('connected');
            this.flush();
        }).catch(() => {
            if (generation === this.generation && !this.disposed) this.failed('error');
        });
    }

    dispose() {
        this.disposed = true;
        this.cancelTimer('playbackTimer');
        this.disconnect();
        this.activity = this.player = null;
    }
}

module.exports = { DiscordPresence, validClientId, artworkUrl };
