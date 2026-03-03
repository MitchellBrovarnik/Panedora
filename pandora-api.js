/**
 * Pandora Glass - REST API Client
 * Direct communication with Pandora's REST API
 */

const https = require('https');
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
            console.log('[API] Generated new CSRF token');
        }
    }

    /**
     * Generate a random CSRF token
     */
    generateCsrfToken() {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let token = '';
        for (let i = 0; i < 16; i++) {
            token += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return token;
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

        // Ensure our CSRF token is in the Chromium cookie jar natively
        // This prevents duplicate Cookie header collisions and allows Chromium to natively manage
        // the PerimeterX `_pxhd` cookie without us stripping it.
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
            // net.fetch routes the request through Chromium's native network stack, 
            // bypassing WAF blocks that trigger on Node's raw TLS fingerprint.
            // By omitting the manual "Cookie" header above, we let Chromium seamlessly pass both
            // our injected csrftoken AND the PerimeterX _pxhd cookie!
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
                    console.log('[API] Captured CSRF token');
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
                    console.log('[API] Session expired (401 or Code 1000)');
                    if (this.onSessionExpired) this.onSessionExpired();
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
     * Login with username/password
     */
    async login(username, password) {
        console.log('[API] Logging in...');

        try {
            const response = await this.request('/v1/auth/login', {
                username,
                password,
                existingAuthToken: null,
                keepLoggedIn: true
            });

            if (response.authToken) {
                // Check subscription tier — free-tier users see ads that this client
                // cannot play, which flags the account. Block them with a clear message.
                const isFree = response.hasInteractiveAds === true
                    || response.subscriptionType === 'FREE'
                    || response.branding === 'pandoraFree';
                const isPaid = response.isPremiumSubscriber === true
                    || response.canListen === true
                    || (response.subscriptionType && response.subscriptionType !== 'FREE');

                console.log('[API] Subscription info:', {
                    subscriptionType: response.subscriptionType,
                    hasInteractiveAds: response.hasInteractiveAds,
                    isPremiumSubscriber: response.isPremiumSubscriber,
                    branding: response.branding,
                    canListen: response.canListen
                });

                if (isFree && !isPaid) {
                    console.log('[API] Free-tier account detected — blocking login');
                    this.authToken = null;
                    return {
                        success: false,
                        error: 'Pandora Glass requires a Pandora Premium or Plus subscription. Free-tier accounts are not supported.'
                    };
                }

                this.authToken = response.authToken;
                config.setAuthToken(response.authToken);
                config.setCredentials(username, password);

                if (response.listenerId) {
                    config.setListenerId(response.listenerId);
                }

                console.log('[API] Login successful');
                console.log('[API] CSRF token after login:', this.csrfToken ? 'captured' : 'MISSING');

                return { success: true, ...response };
            }

            return { success: false, error: 'No auth token received' };
        } catch (error) {
            console.error('[API] Login failed:', error);
            return { success: false, error: error.message || 'Login failed' };
        }
    }

    /**
     * Clear local auth state and logout
     */
    logout() {
        console.log('[API] Logging out...');
        this.authToken = null;
        this.csrfToken = this.generateCsrfToken();
        config.clearAll();
    }

    /**
     * Get user's stations
     */
    async getStations() {
        console.log('[API] Fetching stations...');
        console.log('[API] Using auth token:', this.authToken ? 'present' : 'missing');
        console.log('[API] Using CSRF token:', this.csrfToken ? 'present' : 'missing');

        try {
            const response = await this.request('/v1/station/getStations', {
                pageSize: 250,
                startIndex: 0
            });

            console.log('[API] Stations response:', JSON.stringify(response).substring(0, 500));
            // Log full details to find modes
            if (response.stations && response.stations[0]) {
                console.log('[API] First station details:', JSON.stringify(response.stations[0], null, 2));
            }
            console.log(`[API] Retrieved ${response.stations?.length || 0} stations`);
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
        console.log(`[API] Creating station from seed: ${musicToken}`);

        try {
            const response = await this.request('/v1/station/createStation', {
                musicToken,
                pandoraId: musicToken // Error suggested this might be needed
            });

            console.log('[API] Station created:', response.stationId);
            return response;
        } catch (error) {
            console.error('[API] Failed to create station:', error);
            return null;
        }
    }

    /**
     * Signal playback paused - releases the active stream on Pandora's side
     */
    async playbackPaused() {
        try {
            await this.request('/v1/station/playbackPaused', { sync: false });
            console.log('[API] Sent playbackPaused signal');
        } catch (e) {
            console.log('[API] playbackPaused failed (non-critical):', e?.message || '');
        }
    }

    /**
     * Get available interactive radio modes for a station
     */
    async getInteractiveRadioModes(stationId) {
        try {
            const response = await this.request('/v1/station/getInteractiveRadioModes', { stationId });
            console.log('[API] Interactive radio modes:', JSON.stringify(response));
            return response;
        } catch (e) {
            console.log('[API] getInteractiveRadioModes failed:', e?.message || JSON.stringify(e));
            return null;
        }
    }

    /**
     * Set the interactive radio mode for a station (e.g., artist_only, deep_cuts)
     */
    async setInteractiveRadioMode(stationId, modeId, previousModeId = 0) {
        // Map string mode names to numeric IDs
        const modeMap = {
            'crowd_faves': 1, 'crowd_fave': 1,
            'discovery': 2,
            'deep_cuts': 3,
            'newly_released': 4,
            'artist_only': 6,
            'energy_boost': 7,
            'relax': 8
        };
        const numericMode = modeMap[modeId] !== undefined ? modeMap[modeId] : modeId;

        const payload = {
            stationId,
            modeId: numericMode,
            previousModeId
        };

        console.log('[API] setInteractiveRadioMode PAYLOAD:', JSON.stringify(payload));

        try {
            const response = await this.request('/v1/station/setInteractiveRadioMode', payload);
            console.log('[API] setInteractiveRadioMode SUCCESS:', JSON.stringify(response));
            return response;
        } catch (e) {
            console.error('[API] setInteractiveRadioMode FAILED:', JSON.stringify(e, null, 2));
            console.error('[API] setInteractiveRadioMode error message:', e?.message);
            console.error('[API] setInteractiveRadioMode error status:', e?.status);
            console.error('[API] setInteractiveRadioMode error code:', e?.errorCode);
            return null;
        }
    }

    /**
     * Get playlist tracks for a station
     */
    async getPlaylist(stationId, isStationStart = false, startingAtTrackId = null, { skipRetry = false } = {}) {
        console.log(`[API] Fetching playlist for station ${stationId} (StartTrack: ${startingAtTrackId || 'none'})...`);

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
                    console.log('[API] SimStreamViolation detected (fast-fail, no retry)');
                    return { tracks: [], error: 'Another device is streaming.' };
                }
                console.log('[API] SimStreamViolation detected - another stream active, retrying...');
                response = await this._retryAfterSimStreamViolation(payload);
            }

            const tracks = response.tracks || [];
            const error = response.error || null;

            console.log(`[API] Retrieved ${tracks.length} tracks`);

            // Debug: log first track to see structure
            if (tracks[0]) {
                const t = tracks[0];
                console.log('[API] First track:', t.songTitle, '-', t.artistName);
                console.log('[API] Track mode info: requestedModeId=', t.requestedModeId, 'modeId=', t.modeId);
                console.log('[API] Audio URL:', t.audioURL ? t.audioURL.substring(0, 80) + '...' : 'MISSING');
            }

            return { tracks, error };
        } catch (error) {
            // Check for SimStreamViolation in error response
            const errorStr = JSON.stringify(error);
            if (errorStr.includes('SimStreamViolation')) {
                if (skipRetry) {
                    console.log('[API] SimStreamViolation in error (fast-fail, no retry)');
                    return { tracks: [], error: 'Another device is streaming.' };
                }
                console.log('[API] SimStreamViolation in error - retrying...');
                try {
                    const retryResponse = await this._retryAfterSimStreamViolation(payload);
                    if (retryResponse.tracks?.[0]) {
                        const t = retryResponse.tracks[0];
                        console.log('[API] Retry first track:', t.songTitle, '-', t.artistName);
                    }
                    return { tracks: retryResponse.tracks || [], error: retryResponse.error || null };
                } catch (retryError) {
                    console.error('[API] All retries failed:', JSON.stringify(retryError));
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
            console.log(`[API] SimStream retry ${attempt}/3 - waiting ${attempt * 2}s...`);
            await delay(attempt * 2000);  // 2s, 4s, 6s

            try {
                const response = await this.request('/v1/playlist/getFragment', payload);

                // Check if still SimStreamViolation
                if (response.tracks?.length > 0 && response.tracks[0].trackType === 'SimStreamViolation') {
                    console.log(`[API] Still SimStreamViolation on attempt ${attempt}`);
                    continue;
                }

                console.log(`[API] SimStream resolved on attempt ${attempt}: ${response.tracks?.length || 0} tracks`);
                return response;
            } catch (e) {
                const eStr = JSON.stringify(e);
                if (eStr.includes('SimStreamViolation')) {
                    console.log(`[API] Still SimStreamViolation error on attempt ${attempt}`);
                    continue;
                }
                throw e;  // Different error, don't retry
            }
        }

        console.error('[API] SimStreamViolation persisted after 3 retries');
        return { tracks: [], error: 'Another device is streaming. Please pause it and try again.' };
    }

    /**
     * Add feedback (thumbs up/down)
     */
    async addFeedback(trackToken, isPositive) {
        console.log(`[API] Adding ${isPositive ? 'positive' : 'negative'} feedback...`);

        try {
            const response = await this.request('/v1/station/addFeedback', {
                trackToken,
                isPositive
            });

            console.log('[API] Feedback added successfully, feedbackId:', response?.feedbackId);
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
        console.log(`[API] Deleting feedback ${feedbackId}...`);

        try {
            const response = await this.request('/v1/station/deleteFeedback', {
                feedbackId
            });

            console.log('[API] Feedback deleted successfully');
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
     * Returns true if paid, false if free/unknown.
     */
    async verifySubscription() {
        try {
            const response = await this.request('/v1/user/getSettings', {});
            console.log('[API] User settings for subscription check:', {
                subscriptionType: response.subscriptionType,
                hasInteractiveAds: response.hasInteractiveAds,
                isPremiumSubscriber: response.isPremiumSubscriber,
                branding: response.branding
            });

            const isFree = response.hasInteractiveAds === true
                || response.subscriptionType === 'FREE'
                || response.branding === 'pandoraFree';
            const isPaid = response.isPremiumSubscriber === true
                || (response.subscriptionType && response.subscriptionType !== 'FREE');

            return !(isFree && !isPaid);
        } catch (e) {
            console.error('[API] Subscription check failed:', e?.message || '');
            // If we can't verify, allow login — better than locking out paying users
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
     * Logout - clear stored auth
     */
    /**
     * Transform station (change mode)
     * Experimental: This is the likely endpoint for station modes
     */
    async transformStation(stationId, type) {
        console.log(`[API] Transforming station ${stationId} to mode: ${type}`);
        // Map UI modes to API types if needed
        // Common types: "crowd_faves", "discovery", "deep_cuts", "artist_only", "newly_released"
        // Sometimes just the string is enough

        try {
            const response = await this.request('/v1/station/transform', {
                stationToken: stationId,
                stationCode: stationId, // Error suggested this might be needed
                type: type // e.g., 'crowd_faves'
            });
            console.log('[API] Station transform successful:', response);
            return response;
        } catch (error) {
            console.error('[API] Station transform failed:', JSON.stringify(error, null, 2));
            // Fallback: maybe just return true to proceed with reload if it's a soft failure
            return null;
        }
    }

    /**
     * Remove a station
     */
    async removeStation(stationId) {
        console.log(`[API] Removing station: ${stationId}`);
        try {
            // Try removeStation first
            const response = await this.request('/v1/station/removeStation', {
                stationId
            });
            console.log('[API] Station removed:', response);
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
        console.log(`[API] Searching for: ${query}`);

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

            console.log('[API] Search results keys:', Object.keys(response).join(', '));
            console.log('[API] Search response sample:', JSON.stringify(response).substring(0, 500));

            // Parse results into consistent format
            // Check if response has 'items' array (common in some endpoints)
            let items = [];
            if (response.items) {
                console.log('[API] Search has items array, length:', response.items.length);
                items = response.items;
            } else if (response.tracks || response.artists) {
                // Fallback to old structure if present
                items = [
                    ...(response.tracks || []).map(t => ({ ...t, type: 'song' })),
                    ...(response.artists || []).map(a => ({ ...a, type: 'artist' })),
                    ...(response.stations || []).map(s => ({ ...s, type: 'station' }))
                ];
            }

            if (items.length > 0) {
                const types = [...new Set(items.map(i => i.type))];
                console.log('[API] Search item types found:', types);
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

            // Log full details for the first station to find modes
            if (response.stations && response.stations[0]) {
                console.log('[API] First station details:', JSON.stringify(response.stations[0], null, 2));
            }

            console.log(`[API] Found ${results.songs.length} songs, ${results.artists.length} artists, ${results.stations.length} stations`);
            return results;
        } catch (error) {
            console.error('[API] Search failed:', error);
            return { songs: [], artists: [], stations: [] };
        }
    }
}

module.exports = PandoraAPI;
