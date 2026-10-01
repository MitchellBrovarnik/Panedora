/**
 * Panedora - REST API Client
 * Direct communication with Pandora's REST API
 */

const config = require('./config');

class PandoraAPI {
    constructor() {
        this.baseUrl = 'www.pandora.com';
        this.apiPath = '/api';
        this.authToken = config.getAuthToken();
        this.onSessionExpired = null; // Callback for main process
        this.onVerificationRequired = null;

        // Use a fresh token if Chromium has no cookie. Requests adopt the cookie
        // already in the shared session, including changes made during verification.
        this.csrfToken = this.generateCsrfToken();
        config.setCsrfToken(this.csrfToken);
    }

    /**
     * Generate a random CSRF token
     */
    generateCsrfToken() {
        return require('crypto').randomBytes(16).toString('hex');
    }

    getUserAgent() {
        return require('electron').session.defaultSession.getUserAgent();
    }

    static needsVerification(error) {
        return error?.status === 403 && Number(error.errorCode) === 1215;
    }

    /**
     * Build request headers.
     * Omits X-AuthToken for login endpoints — login authenticates via
     * username/password in the body, and sending a stale token causes
     * Pandora to reject the request after the token has expired.
     */
    _buildHeaders(endpoint) {
        const isLogin = endpoint === '/v1/auth/login';
        const headers = {
            'Content-Type': 'application/json',
            'X-CsrfToken': this.csrfToken || '',
            // Match the verification window's actual browser identity.
            'User-Agent': this.getUserAgent(),
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Origin': 'https://www.pandora.com',
            'Referer': 'https://www.pandora.com/'
        };
        if (!isLogin) {
            headers['X-AuthToken'] = this.authToken || '';
        }
        return headers;
    }

    /**
     * Make an API request
     */
    async request(endpoint, data = {}) {
        const url = `https://${this.baseUrl}${this.apiPath}${endpoint}`;
        let verificationUsed = false;
        let sessionRefreshUsed = false;
        // Each recovery can run once. Verification may reveal an expired auth
        // token, so let the normal session refresh handle that next response.
        while (true) {
            try {
                return await this._requestInternal(url, endpoint, data);
            } catch (error) {
                if (PandoraAPI.needsVerification(error) && this.onVerificationRequired && !verificationUsed) {
                    verificationUsed = true;
                    let verified;
                    try {
                        verified = await this.onVerificationRequired(error, url);
                    } catch (verificationError) {
                        console.error('[API] Could not open verification:', verificationError.message);
                        throw { ...error, message: 'Could not open Pandora verification. Please try signing in again.' };
                    }
                    if (!verified) {
                        throw { ...error, message: 'Pandora verification was cancelled. Sign in again to retry.' };
                    }
                    continue;
                }

                if ((error.status === 401 || error.errorCode === 1000) &&
                    endpoint !== '/v1/auth/login' && this.onSessionExpired && !sessionRefreshUsed) {
                    sessionRefreshUsed = true;
                    const relogged = await this.onSessionExpired();
                    if (relogged) continue;
                }
                throw error;
            }
        }
    }

    /**
     * Internal request method to retry without infinite loops
     */
    async _requestInternal(url, endpoint, data) {
        const { net, session } = require('electron');
        const cookies = await session.defaultSession.cookies.get({ url, name: 'csrftoken' });
        // Prefer the most specific cookie if Pandora supplied a scoped token.
        const csrfCookie = cookies.sort((a, b) => (b.path || '').length - (a.path || '').length)[0];
        if (csrfCookie?.value) {
            this.csrfToken = csrfCookie.value;
            config.setCsrfToken(this.csrfToken);
        } else {
            this.csrfToken = this.csrfToken || this.generateCsrfToken();
            await session.defaultSession.cookies.set({
                url: 'https://www.pandora.com',
                name: 'csrftoken',
                value: this.csrfToken,
                domain: '.pandora.com',
                path: '/',
                secure: true
            });
        }
        const headers = this._buildHeaders(endpoint);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        try {
            const response = await net.fetch(url, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(data),
                signal: controller.signal,
                credentials: 'include'
            });

            const bodyText = await response.text();
            let json;
            try {
                json = JSON.parse(bodyText);
            } catch (e) {
                throw { error: 'Invalid JSON', body: bodyText, status: response.status };
            }

            if (response.ok) {
                return json;
            } else {
                throw { ...json, status: response.status };
            }
        } catch (error) {
            if (error.name === 'AbortError') {
                throw { error: 'Request timed out', message: 'Request timed out' };
            }
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    /**
     * Login with username/password
     */
    async login(username, password) {
        try {
            const response = await this.request('/v1/auth/login', {
                username,
                password,
                existingAuthToken: null,
                keepLoggedIn: true
            });

            if (response.authToken) {
                // Check subscription: require positive proof of paid status
                const isPaid = this._checkLoginSubscription(response);
                if (!isPaid) {
                    return {
                        success: false,
                        error: 'Panedora requires a Pandora Premium or Plus subscription. Free-tier accounts are not supported.'
                    };
                }

                this.authToken = response.authToken;
                config.setAuthToken(response.authToken);

                // Save credentials for auto-relogin on next launch.
                // Wrapped in try/catch so a config write failure doesn't
                // break a successful login (e.g. safeStorage issues on macOS).
                try {
                    config.setCredentials(username, password);
                } catch (e) {
                    console.error('[API] Failed to save credentials:', e.message);
                }

                if (response.listenerId) {
                    config.setListenerId(response.listenerId);
                }

                return { success: true, ...response };
            }

            return { success: false, error: 'No auth token received' };
        } catch (error) {
            console.error('[API] Login failed:', {
                status: error.status,
                message: error.message,
                errorCode: error.errorCode,
                errorString: error.errorString
            });
            const message = PandoraAPI.needsVerification(error) && error.message === 'Invalid request'
                ? 'Pandora is still requiring browser verification. Sign in again to retry the check.'
                : error.message || 'Login failed';
            return { success: false, error: message, status: error.status, errorCode: error.errorCode };
        }
    }

    /**
     * Check subscription status from login response fields.
     * The v1 REST API embeds subscription info in config.branding, config.flags,
     * highQualityStreamingEnabled, adkv.iat, and smartConversionDisabled.
     * Returns true if the account is a paid subscriber (Premium or Plus).
     */
    _checkLoginSubscription(response) {
        const freeSignals = [];
        const paidSignals = [];
        const cfg = response.config || {};
        const flags = cfg.flags || [];
        const adkv = response.adkv || {};

        // --- config.branding: "Pandora" = free, anything else (PandoraPremium, PandoraPlus, etc.) = paid ---
        if (cfg.branding && cfg.branding !== 'Pandora') {
            paidSignals.push('branding=' + cfg.branding);
        } else if (cfg.branding === 'Pandora') {
            freeSignals.push('branding=Pandora');
        }

        // --- config.flags: ad-free flags = paid, ad-supported flags = free ---
        if (flags.includes('onDemand')) paidSignals.push('flag:onDemand');
        if (flags.includes('adFreeSkip')) paidSignals.push('flag:adFreeSkip');
        if (flags.includes('adFreeReplay')) paidSignals.push('flag:adFreeReplay');
        if (flags.includes('highQualityStreamingAvailable')) paidSignals.push('flag:highQualityStreaming');
        if (flags.includes('adSupportedSkip')) freeSignals.push('flag:adSupportedSkip');
        if (flags.includes('adSupportedReplay')) freeSignals.push('flag:adSupportedReplay');

        // --- highQualityStreamingEnabled ---
        if (response.highQualityStreamingEnabled === true) paidSignals.push('highQualityStreaming');
        if (response.highQualityStreamingEnabled === false) freeSignals.push('noHighQualityStreaming');

        // --- adkv.iat: "1" = has interactive ads (free), "0" = no ads (paid) ---
        if (adkv.iat === '0') paidSignals.push('noInteractiveAds');
        if (adkv.iat === '1') freeSignals.push('hasInteractiveAds');

        // --- smartConversionDisabled: true = paid (no upsell needed), false = free ---
        if (response.smartConversionDisabled === true) paidSignals.push('smartConversionDisabled');
        if (response.smartConversionDisabled === false) freeSignals.push('smartConversionEnabled');

        // If we found ANY paid signals, allow (paid overrides any false positives)
        if (paidSignals.length > 0) {
            return true;
        }

        // If we found free signals, block
        if (freeSignals.length > 0) {
            return false;
        }

        // No signals at all — block to be safe
        return false;
    }

    /**
     * Clear local auth state and logout
     */
    logout() {
        this.authToken = null;
        this.csrfToken = this.generateCsrfToken();
        config.clearAll();
    }

    /**
     * Get user's stations
     */
    async getStations() {
        try {
            const response = await this.request('/v1/station/getStations', {
                pageSize: 250,
                startIndex: 0
            });

            return response.stations || [];
        } catch (error) {
            console.error('[API] Failed to get stations:', error);
            // If it's an auth error, don't return an empty array, let the UI handle the status
            if (error.status === 401 || error.errorCode === 1000) {
                return null;
            }
            return [];
        }
    }

    /**
     * Get the Shuffle (QuickMix) station
     */
    async getShuffleStation() {
        try {
            return await this.request('/v1/station/shuffle', {});
        } catch (error) {
            console.error('[API] Failed to get shuffle station:', error);
            return null;
        }
    }

    /**
     * Create a new station from a seed (artist or track)
     */
    async createStation(musicToken) {
        try {
            const response = await this.request('/v1/station/createStation', {
                musicToken,
                pandoraId: musicToken
            });

            return response;
        } catch (error) {
            console.error('[API] Failed to create station:', error);
            return null;
        }
    }

    // Interactive radio uses its own endpoints. Mode IDs must come from Pandora,
    // including curated/mood modes; a menu position is not a mode ID.
    static parseStationModes(response) {
        const data = response?.result || response;
        if (response?.stat === 'fail' || response?.errorCode ||
            (!Array.isArray(data?.availableModes) && data?.interactiveRadioAvailable !== false)) {
            throw new Error('Invalid station modes response');
        }
        const modeId = value => {
            if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
            const id = Number(value);
            return Number.isSafeInteger(id) && id >= 0 ? id : null;
        };
        const seen = new Set();
        const modes = (data.availableModes || []).flatMap(mode => {
            const id = modeId(mode?.modeId);
            if (id === null || seen.has(id) || typeof mode?.modeName !== 'string' || !mode.modeName.trim()) return [];
            seen.add(id);
            return [{
                id,
                name: mode.modeName,
                description: typeof mode.modeDescription === 'string' ? mode.modeDescription : '',
                available: mode.isModeAvailable === true,
                premiumOnly: mode.isPremiumOnly === true
            }];
        });
        return {
            success: true,
            available: data.interactiveRadioAvailable !== false && modes.length > 0,
            currentModeId: modeId(data.currentModeId),
            modes
        };
    }

    async getStationModes(stationId) {
        try {
            const response = await this.request('/v1/interactiveradio/getAvailableModesSimple', { stationId });
            if (PandoraAPI.isStreamConflict(response)) throw response;
            return PandoraAPI.parseStationModes(response);
        } catch (error) {
            return {
                success: false,
                streamConflict: PandoraAPI.isStreamConflict(error),
                error: 'Could not load station modes. Please try again.'
            };
        }
    }

    async setStationMode(stationId, modeId) {
        if (!Number.isSafeInteger(modeId) || modeId < 0) {
            return { success: false, error: 'Choose a mode offered by this station.' };
        }
        try {
            const response = await this.request('/v1/interactiveradio/setAndGetAvailableModes', { stationId, modeId });
            if (PandoraAPI.isStreamConflict(response)) throw response;
            const result = PandoraAPI.parseStationModes(response);
            // Pandora can return HTTP 200 while silently keeping the old mode.
            if (result.currentModeId !== modeId) {
                return { ...result, success: false, error: 'Pandora did not enable that mode. Choose another available mode.' };
            }
            return result;
        } catch (error) {
            return {
                success: false,
                streamConflict: PandoraAPI.isStreamConflict(error),
                error: 'Could not confirm the station mode. Please try again.'
            };
        }
    }

    /** Get playlist tracks for a station. */
    static isStreamConflict(value) {
        return value?.errorString === 'STREAM_VIOLATION' ||
            ['SimStreamViolation', 'SimStreamViolationItem'].includes(value?.trackType) ||
            value?.tracks?.some(track => PandoraAPI.isStreamConflict(track)) === true ||
            /SimStreamViolation/.test(value?.message || '');
    }

    async getPlaylist(stationId, isStationStart = false, startingAtTrackId = null) {
        try {
            const response = await this.request('/v1/playlist/getFragment', {
                stationId,
                isStationStart,
                fragmentRequestReason: 'Normal',
                audioFormat: 'aacplus',
                startingAtTrackId: startingAtTrackId || null,
                onDemandArtistMessageArtistUidHex: null,
                onDemandArtistMessageIdHex: null
            });
            if (PandoraAPI.isStreamConflict(response)) {
                return { tracks: [], streamConflict: true, error: 'Another device is streaming.' };
            }
            return { tracks: response.tracks || [], error: response.error || null };
        } catch (error) {
            if (PandoraAPI.isStreamConflict(error)) {
                return { tracks: [], streamConflict: true, error: 'Another device is streaming.' };
            }
            console.error('[API] Failed to get playlist:', error.message || error.errorString || error.status);
            return { tracks: [], error: 'Failed to load playlist. Please try again.' };
        }
    }

    /**
     * Resume normally, or take over only after the user chooses Let me listen.
     */
    async playbackResumed(forceActive = false) {
        try {
            const response = await this.request('/v1/station/playbackResumed', { forceActive: forceActive === true });
            if (PandoraAPI.isStreamConflict(response)) {
                return { success: false, streamConflict: true, error: 'Another device is streaming.' };
            }
            return { success: true };
        } catch (error) {
            return {
                success: false,
                streamConflict: PandoraAPI.isStreamConflict(error),
                error: 'Could not resume Pandora playback. Please try again.'
            };
        }
    }

    /**
     * Add feedback (thumbs up/down)
     */
    async addFeedback(trackToken, isPositive) {
        try {
            const response = await this.request('/v1/station/addFeedback', {
                trackToken,
                isPositive
            });

            return { success: true, feedbackId: response?.feedbackId, ...response };
        } catch (error) {
            console.error('[API] Failed to add feedback:', error);
            return { success: false, error };
        }
    }

    /**
     * Delete feedback (undo thumbs up/down)
     */
    async deleteFeedback(feedbackId) {
        try {
            const response = await this.request('/v1/station/deleteFeedback', {
                feedbackId
            });

            return { success: true, ...response };
        } catch (error) {
            console.error('[API] Failed to delete feedback:', error);
            return { success: false, error };
        }
    }

    /**
     * Report track started (for scrobbling/analytics)
     */
    async trackStarted(stationId, trackToken) {
        try {
            await this.request('/v1/station/trackStarted', {
                stationId,
                trackToken
            });
            return true;
        } catch (error) {
            console.error('[API] Failed to report track started:', error);
            return false;
        }
    }

    /**
     * Report playback paused
     */
    async playbackPaused(stationId, trackToken) {
        try {
            await this.request('/v1/station/playbackPaused', {
                stationId,
                trackToken
            });
            return true;
        } catch (error) {
            console.error('[API] Failed to report pause:', error);
            return false;
        }
    }

    /**
     * Get highest resolution artwork from art array
     */
    static getHighResArt(artArray) {
        if (!artArray || !Array.isArray(artArray) || artArray.length === 0) {
            return null;
        }

        // Single-pass max search (O(N)) for optimal performance
        let maxArt = artArray[0];
        for (let i = 1; i < artArray.length; i++) {
            if ((artArray[i].size || 0) > (maxArt.size || 0)) {
                maxArt = artArray[i];
            }
        }
        return maxArt?.url || null;
    }

    /**
     * Check if currently authenticated
     */
    isAuthenticated() {
        return this.authToken !== null && this.authToken !== undefined;
    }

    /**
     * Verify the current session has a paid subscription.
     * Re-authenticates with stored credentials to check subscription fields
     * from the login response (the v1 REST API has no standalone subscription endpoint).
     * Returns true if paid, false if free/unknown.
     */
    async verifySubscription() {
        try {
            const creds = config.getCredentials();
            if (!creds?.email || !creds?.password) {
                return true; // Can't verify without credentials, allow to avoid lock-out
            }

            const response = await this.request('/v1/auth/login', {
                username: creds.email,
                password: creds.password,
                existingAuthToken: null,
                keepLoggedIn: true
            });

            if (!response.authToken) {
                return false;
            }

            // Update the auth token (it may have changed)
            this.authToken = response.authToken;
            config.setAuthToken(response.authToken);

            return this._checkLoginSubscription(response);
        } catch (e) {
            console.error('[API] Subscription re-check failed:', e?.message || '');
            // If we can't verify, allow — better than locking out paying users
            return true;
        }
    }

    /**
     * Restore auth from stored config
     */
    restoreAuth() {
        this.authToken = config.getAuthToken();
        this.csrfToken = config.getCsrfToken();
        return this.isAuthenticated();
    }

    /**
     * Remove a station
     */
    async removeStation(stationId) {
        try {
            await this.request('/v1/station/removeStation', {
                stationId
            });
            return true;
        } catch (error) {
            console.error('[API] Failed to remove station:', error);
            return false;
        }
    }

    /**
     * Search for songs, artists, and stations
     */
    async search(query) {
        if (!query || query.length < 2) {
            return { songs: [], artists: [], stations: [] };
        }

        try {
            const response = await this.request('/v1/search/fullSearch', {
                query,
                types: ['TR', 'AR', 'SF', 'AL', 'PL'],  // TR=tracks, AR=artists, SF=station, AL=albums, PL=playlists
                listener: null,
                start: 0,
                count: 50  // Request more results to match web
            });

            // Parse results into consistent format
            let items = [];
            if (response.items) {
                items = response.items;
            } else if (response.tracks || response.artists) {
                // Fallback to old structure if present
                items = [
                    ...(response.tracks || []).map(t => ({ ...t, type: 'song' })),
                    ...(response.artists || []).map(a => ({ ...a, type: 'artist' })),
                    ...(response.stations || []).map(s => ({ ...s, type: 'station' }))
                ];
            }

            const results = {
                songs: items.filter(i => i.type === 'song' || i.type === 'TR' || i.type === 'track').map(t => ({
                    id: t.pandoraId || t.musicId,
                    title: t.songTitle || t.name,
                    artist: t.artistName,
                    album: t.albumTitle,
                    image: PandoraAPI.getHighResArt(t.albumArt || t.art),
                    trackToken: t.trackToken,
                    pandoraId: t.pandoraId,
                    type: 'song'
                })),
                artists: items.filter(i => i.type === 'artist' || i.type === 'AR').map(a => ({
                    id: a.pandoraId || a.musicId,
                    name: a.name,
                    image: PandoraAPI.getHighResArt(a.art),
                    listenerCount: a.listenerCount,
                    type: 'artist'
                })),
                stations: items.filter(i => i.type === 'station' || i.type === 'SF' || i.type === 'ST').map(s => ({
                    id: s.stationId || s.pandoraId || s.musicId,
                    stationId: s.stationId,
                    stationFactoryPandoraId: s.stationFactoryPandoraId,
                    pandoraId: s.pandoraId,
                    name: s.name,
                    art: s.art,
                    image: PandoraAPI.getHighResArt(s.art),
                    type: 'station'
                }))
            };

            return results;
        } catch (error) {
            console.error('[API] Search failed:', error);
            return { songs: [], artists: [], stations: [] };
        }
    }
}

module.exports = PandoraAPI;
