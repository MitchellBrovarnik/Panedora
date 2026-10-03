const RELEASE_API = 'https://api.github.com/repos/MitchellBrovarnik/Panedora/releases/latest';
const DOWNLOAD_URL = 'https://github.com/MitchellBrovarnik/Panedora/releases/latest';
const REMIND_AFTER = 24 * 60 * 60 * 1000;
const CHECK_INTERVAL = 24 * 60 * 60 * 1000;
const RETRY_INTERVAL = 15 * 60 * 1000;
const MAX_RETRY_INTERVAL = 60 * 60 * 1000;

function retryDelay(response, failures, now) {
    let delay = Math.min(MAX_RETRY_INTERVAL, RETRY_INTERVAL * 2 ** Math.min(failures - 1, 2));
    if (response?.status !== 403 && response?.status !== 429) return delay;
    const after = response.headers?.get?.('retry-after');
    if (after) {
        const seconds = Number(after);
        const until = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(after);
        if (Number.isFinite(until)) delay = Math.max(delay, until - now);
    }
    const reset = response.headers?.get?.('x-ratelimit-reset');
    if (reset && Number.isFinite(Number(reset))) delay = Math.max(delay, Number(reset) * 1000 - now);
    return delay;
}

function parseVersion(value) {
    if (typeof value !== 'string' || value.length > 100) return null;
    const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/i.exec(value);
    if (!match || match[0] !== value) return null;
    const parts = match.slice(1, 4).map(Number);
    if (!parts.every(Number.isSafeInteger) || match[4]?.split('.').some(part => /^0\d+$/.test(part))) return null;
    return { parts, prerelease: !!match[4], label: value.replace(/^v/i, '') };
}

function isNewerRelease(latest, current) {
    if (!latest || !current || latest.prerelease) return false;
    for (let i = 0; i < 3; i++) {
        if (latest.parts[i] !== current.parts[i]) return latest.parts[i] > current.parts[i];
    }
    return current.prerelease;
}

function hasInstaller(release, platform, arch) {
    const extension = { win32: '.exe', darwin: '.dmg', linux: '.AppImage' }[platform];
    return !!extension && Array.isArray(release.assets) && release.assets.some(asset => {
        const name = asset?.name;
        if (typeof name !== 'string' || !name.endsWith(extension)) return false;
        if (/arm64/i.test(name) && arch !== 'arm64') return false;
        if (/(?:x64|amd64)/i.test(name) && arch !== 'x64') return false;
        return true;
    });
}

class UpdateChecker {
    constructor({ version, fetch, getSnooze, setSnooze, platform, arch, now = Date.now, timeoutMs = 10000,
        onNotice = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
        this.current = parseVersion(version);
        Object.assign(this, { fetch, getSnooze, setSnooze, platform, arch, now, timeoutMs, onNotice, setTimer, clearTimer });
        this.notice = null;
        this.availableNotice = null;
        this.snoozeUntil = 0;
        this.checkPromise = null;
        this.nextCheckAt = 0;
        this.failures = 0;
        this.timer = null;
        this.controller = null;
        this.running = false;
        this.stopped = false;
    }

    start() {
        if (this.running || this.stopped || !this.current) return;
        this.running = true;
        return this.check();
    }

    stop() {
        this.stopped = true;
        this.running = false;
        if (this.timer !== null) this.clearTimer(this.timer);
        this.timer = null;
        this.controller?.abort();
    }

    async check() {
        if (this.stopped || !this.current) return null;
        // Reloads, focus and wake events share the daily deadline and in-flight request.
        if (!this.checkPromise && this.now() >= this.nextCheckAt) {
            this.checkPromise = this._check().finally(() => { this.checkPromise = null; });
        }
        if (this.checkPromise) await this.checkPromise;
        if (this.stopped) return null;
        this._refreshNotice();
        this._schedule();
        return this.notice;
    }

    _schedule() {
        if (!this.running || this.stopped || this.checkPromise) return;
        if (this.timer !== null) this.clearTimer(this.timer);
        // Recompute after waking: time asleep counts toward the deadline.
        let deadline = this.nextCheckAt;
        if (this.snoozeUntil > this.now()) deadline = Math.min(deadline, this.snoozeUntil);
        this.timer = this.setTimer(() => {
            this.timer = null;
            void this.check();
        }, Math.max(1, Math.min(2147483647, deadline - this.now())));
        this.timer?.unref?.();
    }

    _setNotice(notice) {
        if (this.notice?.version === notice?.version && this.notice?.currentVersion === notice?.currentVersion) return;
        this.notice = notice;
        try { this.onNotice(notice); } catch { /* A closing UI must not interrupt checks. */ }
    }

    _refreshNotice() {
        const available = this.availableNotice;
        let snooze;
        try { snooze = available && this.getSnooze(); } catch { return; }
        this.snoozeUntil = snooze?.version === available?.version && Number.isFinite(snooze?.until) ? snooze.until : 0;
        this._setNotice(this.snoozeUntil > this.now() ? null : available);
    }

    async _check() {
        const controller = new AbortController();
        this.controller = controller;
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        let response;
        let success = false;
        try {
            response = await this.fetch(RELEASE_API, {
                method: 'GET', credentials: 'omit', redirect: 'error', signal: controller.signal,
                headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Panedora update check' }
            });
            if (!response.ok) return;
            const release = await response.json();
            const latest = parseVersion(release?.tag_name);
            if (!latest || typeof release.draft !== 'boolean' || typeof release.prerelease !== 'boolean' ||
                !Array.isArray(release.assets)) return;
            if (this.stopped) return;
            this.availableNotice = release.draft === false && release.prerelease === false &&
                isNewerRelease(latest, this.current) && hasInstaller(release, this.platform, this.arch)
                ? { version: latest.label, currentVersion: this.current.label } : null;
            success = true;
        } catch {
            // Offline, rate limited or malformed responses must not interrupt playback.
        } finally {
            clearTimeout(timeout);
            this.controller = null;
            if (!this.stopped) {
                this.failures = success ? 0 : this.failures + 1;
                this.nextCheckAt = this.now() + (success ? CHECK_INTERVAL : retryDelay(response, this.failures, this.now()));
            }
        }
    }

    dismiss(version) {
        if (!this.notice || this.notice.version !== version) return false;
        this.setSnooze({ version, until: this.now() + REMIND_AFTER });
        this._refreshNotice();
        this._schedule();
        return true;
    }
}

module.exports = { UpdateChecker, DOWNLOAD_URL, RELEASE_API, parseVersion, isNewerRelease };
