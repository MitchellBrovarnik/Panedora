const RELEASE_API = 'https://api.github.com/repos/MitchellBrovarnik/Panedora/releases/latest';
const DOWNLOAD_URL = 'https://github.com/MitchellBrovarnik/Panedora/releases/latest';
const REMIND_AFTER = 24 * 60 * 60 * 1000;

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
    constructor({ version, fetch, getSnooze, setSnooze, platform, arch, now = Date.now, timeoutMs = 10000 }) {
        this.current = parseVersion(version);
        Object.assign(this, { fetch, getSnooze, setSnooze, platform, arch, now, timeoutMs });
        this.notice = null;
        this.checkPromise = null;
    }

    async check() {
        // One check per app launch, shared by concurrent renderer requests.
        if (!this.checkPromise) this.checkPromise = this._check();
        await this.checkPromise;
        return this.notice;
    }

    async _check() {
        if (!this.current) return;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await this.fetch(RELEASE_API, {
                method: 'GET', credentials: 'omit', redirect: 'error', signal: controller.signal,
                headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Panedora update check' }
            });
            if (!response.ok) return;
            const release = await response.json();
            const latest = parseVersion(release?.tag_name);
            if (release?.draft !== false || release.prerelease !== false ||
                !isNewerRelease(latest, this.current) || !hasInstaller(release, this.platform, this.arch)) return;
            const snooze = this.getSnooze();
            if (snooze?.version === latest.label && Number.isFinite(snooze.until) && snooze.until > this.now()) return;
            this.notice = { version: latest.label, currentVersion: this.current.label };
        } catch {
            // Offline, rate limited or malformed responses must not interrupt playback.
        } finally {
            clearTimeout(timeout);
        }
    }

    dismiss(version) {
        if (!this.notice || this.notice.version !== version) return false;
        this.setSnooze({ version, until: this.now() + REMIND_AFTER });
        this.notice = null;
        return true;
    }
}

module.exports = { UpdateChecker, DOWNLOAD_URL, RELEASE_API, parseVersion, isNewerRelease };
