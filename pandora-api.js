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
        return new Promise((resolve, reject) => {
            const postData = JSON.stringify(data);

            const options = {
                hostname: this.baseUrl,
                port: 443,
                path: `${this.apiPath}${endpoint}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData),
                    'X-AuthToken': this.authToken || '',
                    'X-CsrfToken': this.csrfToken || '',
                    'Cookie': this.csrfToken ? `csrftoken=${this.csrfToken}` : '',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            };

            const req = https.request(options, (res) => {
                let body = '';

                // Capture CSRF token from cookies
                const cookies = res.headers['set-cookie'];
                if (cookies) {
                    for (const cookie of cookies) {
                        const csrfMatch = cookie.match(/csrftoken=([^;]+)/);
                        if (csrfMatch) {
                            this.csrfToken = csrfMatch[1];
                            config.setCsrfToken(this.csrfToken);
                        }
                    }
                }

                res.on('data', (chunk) => body += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(body);
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(json);
                        } else {
                            if (res.statusCode === 401 || json.errorCode === 1000) {
                                if (this.onSessionExpired) this.onSessionExpired();
                            }
                            reject({ status: res.statusCode, ...json });
                        }
                    } catch (e) {
                        reject({ error: 'Invalid JSON', body, status: res.statusCode });
                    }
                });
            });

            req.on('error', reject);
            req.setTimeout(30000, () => {
                req.destroy(new Error('Request timed out'));
            });
            req.write(postData);
            req.end();
        });
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
                // Check subscription tier — free-tier users see ads that this client
                // cannot play, which flags the account. Block them with a clear message.
                const isFree = response.hasInteractiveAds === true
                    || response.subscriptionType === 'FREE'
                    || response.branding === 'pandoraFree';
                const isPaid = response.isPremiumSubscriber === true
                    || response.canListen === true
                    || (response.subscriptionType && response.subscriptionType !== 'FREE');

                if (isFree && !isPaid) {
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
     * Returns true if paid, false if free/unknown.
     */
    async verifySubscription() {
        try {
            const response = await this.request('/v1/user/getSettings', {});

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
