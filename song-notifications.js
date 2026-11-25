'use strict';

// The main process owns notification eligibility and deduplication. Renderer
// reports prove that audio has started; they never supply notification content.
class SongNotifications {
    constructor({ enabled, getState, canShow, loadArtwork, show, delay = 500, onError = () => {} }) {
        Object.assign(this, { enabled, getState, canShow, loadArtwork, show, delay, onError });
        this.lastToken = null;
        this.pending = null;
        this.active = null;
    }

    matches(report, state = this.getState()) {
        return !!state?.trackToken && !!state.audioURL && state.isPlaying &&
            !state.streamBlocked && !state.stationLoading &&
            report?.trackToken === state.trackToken &&
            report.playbackGeneration === state.playbackGeneration;
    }

    report(report) {
        const state = this.getState();
        if (!report || typeof report.playing !== 'boolean') return false;
        if (!report.playing) {
            if (this.pending && report.trackToken === this.pending.report.trackToken &&
                report.playbackGeneration === this.pending.report.playbackGeneration) this.cancelPending();
            return false;
        }
        if (!this.matches(report, state) || state.trackToken === this.lastToken) return false;
        // Consume even in foreground or while disabled: resuming, enabling the
        // preference or moving the window later must never announce an old song.
        this.lastToken = state.trackToken;
        this.cancelPending();
        this.closeActive();
        if (!this.enabled() || !this.canShow()) return false;
        const pending = { report: { trackToken: state.trackToken, playbackGeneration: state.playbackGeneration }, controller: new AbortController() };
        this.pending = pending;
        pending.timer = setTimeout(() => void this.deliver(pending), this.delay);
        return true;
    }

    eligible(pending) {
        return this.pending === pending && this.enabled() && this.canShow() && this.matches(pending.report);
    }

    async deliver(pending) {
        try {
            if (!this.eligible(pending)) return;
            const state = this.getState();
            let icon;
            try { icon = await this.loadArtwork(state.coverArt, pending.controller.signal); } catch { /* text-only fallback */ }
            if (!this.eligible(pending)) return;
            this.active = this.show({
                title: state.track || 'Unknown track',
                body: [state.artist || 'Unknown artist', state.album].filter(Boolean).join('\n'),
                silent: true,
                ...(icon ? { icon } : {})
            });
        } catch (error) {
            this.onError(error);
        } finally {
            if (this.pending === pending) this.pending = null;
        }
    }

    cancelPending() {
        const pending = this.pending;
        this.pending = null;
        if (pending) {
            clearTimeout(pending.timer);
            pending.controller.abort();
        }
    }

    closeActive() {
        const active = this.active;
        this.active = null;
        try { active?.close(); } catch { /* native service may have already dismissed it */ }
    }

    invalidate() { this.cancelPending(); }
    dispose() { this.invalidate(); this.closeActive(); }
}

function canShowSongNotification(win, isMini) {
    return !!win && !win.isDestroyed() && !win.isFocused() &&
        !(isMini && win.isVisible() && !win.isMinimized() && win.isAlwaysOnTop());
}

module.exports = { SongNotifications, canShowSongNotification };
