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
        this.csrfToken = config.getCsrfToken();
        this.onSessionExpired = null; // Callback for main process

        // Generate CSRF token if missing - Pandora API docs say client can generate their own
        // The API just validates that the X-CsrfToken header matches the csrftoken cookie
        if (!this.csrfToken) {
            this.csrfToken = this.generateCsrfToken();
            config.setCsrfToken(this.csrfToken);
        }
    }

    /**
     * Generate a random CSRF token
     */
    generateCsrfToken() {
        return require('crypto').randomBytes(16).toString('hex');
    }

    /**
     * Make an API request
     */
    async request(endpoint, data = {}) {
        const { net } = require('electron');
        const url = `https://${this.baseUrl}${this.apiPath}${endpoint}`;

        const headers = {
            'Content-Type': 'application/json',
            'X-AuthToken': this.authToken || '',
            'X-CsrfToken': this.csrfToken || '',
            'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`,
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Origin': 'https://www.pandora.com',
            'Referer': 'https://www.pandora.com/',
            'sec-ch-ua': `"Not_A Brand";v="8", "Chromium";v="${process.versions.chrome.split('.')[0]}", "Google Chrome";v="${process.versions.chrome.split('.')[0]}"`,
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin'
        };

        const { session } = require('electron');
        const cookieSession = session.defaultSession;

        // Ensure our CSRF token is in the Chromium cookie jar
        if (this.csrfToken) {
            try {
                await cookieSession.cookies.set({
                    url: 'https://www.pandora.com',
                    name: 'csrftoken',
                    value: this.csrfToken,
                    domain: '.pandora.com',
                    path: '/',
                    secure: true
                });
            } catch (e) {
                console.error('[API] Failed to set cookie natively:', e);
            }
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        try {
            // Use Chromium's native network stack for cookie management
            const response = await net.fetch(url, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(data),
                signal: controller.signal,
                credentials: 'include'
            });

            clearTimeout(timeout);

            // Capture CSRF token
            let cookies = [];
            if (typeof response.headers.getSetCookie === 'function') {
                cookies = response.headers.getSetCookie();
            } else {
                const cookieStr = response.headers.get('set-cookie');
                if (cookieStr) cookies = [cookieStr];
            }

            for (const cookie of cookies) {
                const csrfMatch = cookie.match(/csrftoken=([^;]+)/);
                if (csrfMatch) {
                    this.csrfToken = csrfMatch[1];
                    config.setCsrfToken(this.csrfToken);
                }
            }

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
                if (response.status === 401 || json.errorCode === 1000) {
                    if (this.onSessionExpired) {
                        const relogged = await this.onSessionExpired();
                        if (relogged) {
                            // Retry the request once after successful relogin
                            return await this._requestInternal(url, endpoint, data);
                        }
                    }
                }
                throw { status: response.status, ...json };
            }
        } catch (error) {
            clearTimeout(timeout);
            if (error.name === 'AbortError') {
                throw { error: 'Request timed out' };
            }
            throw error;
        }
    }

    /**
     * Internal request method to retry without infinite loops
     */
    async _requestInternal(url, endpoint, data) {
        const { net } = require('electron');
        const headers = {
            'Content-Type': 'application/json',
            'X-AuthToken': this.authToken || '',
            'X-CsrfToken': this.csrfToken || '',
            'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`,
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Origin': 'https://www.pandora.com',
            'Referer': 'https://www.pandora.com/',
            'sec-ch-ua': `"Not_A Brand";v="8", "Chromium";v="${process.versions.chrome.split('.')[0]}", "Google Chrome";v="${process.versions.chrome.split('.')[0]}"`,
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin'
        };

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

            clearTimeout(timeout);

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
                throw { status: response.status, ...json };
            }
        } catch (error) {
            clearTimeout(timeout);
            throw error;
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
                config.setCredentials(username, password);

                if (response.listenerId) {
                    config.setListenerId(response.listenerId);
                }

                return { success: true, ...response };
            }

            return { success: false, error: 'No auth token received' };
        } catch (error) {
            console.error('[API] Login failed:', error);
            return { success: false, error: error.message || 'Login failed' };
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

    /**
     * Get playlist tracks for a station
     */
    async getPlaylist(stationId, isStationStart = false, startingAtTrackId = null, { skipRetry = false } = {}) {
        try {
            const payload = {
                stationId,
                isStationStart,
                fragmentRequestReason: 'Normal',
                audioFormat: 'aacplus',
                startingAtTrackId: startingAtTrackId || null,
                onDemandArtistMessageArtistUidHex: null,
                onDemandArtistMessageIdHex: null
            };

            let response = await this.request('/v1/playlist/getFragment', payload);

            // Check for SimStreamViolation (another device is streaming) - success path
            if (response.tracks?.length > 0 && response.tracks[0].trackType === 'SimStreamViolation') {
                if (skipRetry) {
                    return { tracks: [], error: 'Another device is streaming.' };
                }
                response = await this._retryAfterSimStreamViolation(payload);
            }

            return { tracks: response.tracks || [], error: response.error || null };
        } catch (error) {
            // Check for SimStreamViolation in error response
            const errorStr = JSON.stringify(error);
            if (errorStr.includes('SimStreamViolation')) {
                if (skipRetry) {
                    return { tracks: [], error: 'Another device is streaming.' };
                }
                try {
                    const retryResponse = await this._retryAfterSimStreamViolation(payload);
                    return { tracks: retryResponse.tracks || [], error: retryResponse.error || null };
                } catch (retryError) {
                    return { tracks: [], error: 'Failed to load playlist. Please try again.' };
                }
            }
            console.error('[API] Failed to get playlist:', errorStr);
            return { tracks: [], error: 'Failed to load playlist.' };
        }
    }

    /**
     * Retry getFragment after SimStreamViolation with delays
     */
    async _retryAfterSimStreamViolation(payload) {
        const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        for (let attempt = 1; attempt <= 3; attempt++) {
            await delay(attempt * 2000);  // 2s, 4s, 6s

            try {
                const response = await this.request('/v1/playlist/getFragment', payload);

                // Check if still SimStreamViolation
                if (response.tracks?.length > 0 && response.tracks[0].trackType === 'SimStreamViolation') {
                    continue;
                }

                return response;
            } catch (e) {
                const eStr = JSON.stringify(e);
                if (eStr.includes('SimStreamViolation')) {
                    continue;
                }
                throw e;  // Different error, don't retry
            }
        }

        return { tracks: [], error: 'Another device is streaming. Please pause it and try again.' };
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
