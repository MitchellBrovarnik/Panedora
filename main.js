/**
 * Pandora Glass v2 - Main Process
 * Direct API-based architecture (no hidden browser)
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// Disable GPU caching to prevent 'Access is denied' cache_util_win errors on Windows startup
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-gpu-disk-cache');

// Debug Logging
const LOG_FILE = path.join(__dirname, 'debug.log');
function logToFile(msg) {
    try {
        const timestamp = new Date().toISOString();
        fs.appendFileSync(LOG_FILE, `[${timestamp}] ${msg}\n`);
    } catch (e) {
        // ignore
    }
}
const originalLog = console.log;
console.log = function (...args) {
    originalLog.apply(console, args);
    logToFile(args.join(' '));
};
const originalError = console.error;
console.error = function (...args) {
    originalError.apply(console, args);
    logToFile('[ERROR] ' + args.join(' '));
};
const PandoraAPI = require('./pandora-api');
const config = require('./config');

let uiWindow = null;
let api = null;

// Current state
let currentStations = [];
let currentStation = null;
let currentPlaylist = [];
let currentTrackIndex = 0;
let songHistory = []; // Track played songs for history display
let isMiniPlayer = false;
let savedBounds = null; // Save window position/size before entering mini mode
let isLoadingMoreTracks = false;

// ============================================================================
// Window Creation
// ============================================================================

function createUIWindow() {
    uiWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000', // MUST be transparent to allow CSS transparency
        webPreferences: {
            preload: path.join(__dirname, 'preload-ui.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    uiWindow.loadFile('index.html');

    if (process.argv.includes('--dev')) {
        uiWindow.webContents.openDevTools();
    }

    uiWindow.on('closed', () => {
        uiWindow = null;
    });
}

// ============================================================================
// Mini Player Toggle
// ============================================================================

ipcMain.handle('WINDOW:TOGGLE_MINI', async () => {
    if (!uiWindow) return { isMini: false };

    isMiniPlayer = !isMiniPlayer;

    if (isMiniPlayer) {
        // Save current bounds before shrinking
        savedBounds = uiWindow.getBounds();
        uiWindow.setMenuBarVisibility(false);
        uiWindow.setAutoHideMenuBar(true);
        uiWindow.setMinimumSize(480, 80);
        uiWindow.setSize(540, 100);
        // Use 'screen-saver' level to stay on top of fullscreen borderless games
        uiWindow.setAlwaysOnTop(true, 'screen-saver');
        uiWindow.setResizable(true); // Let user resize it a bit horizontally if they want
    } else {
        // Restore saved bounds
        uiWindow.setAlwaysOnTop(false);
        uiWindow.setResizable(true);
        uiWindow.setMenuBarVisibility(true);
        uiWindow.setAutoHideMenuBar(false);
        uiWindow.setMinimumSize(900, 600);
        if (savedBounds) {
            uiWindow.setBounds(savedBounds);
        } else {
            uiWindow.setSize(1200, 800);
        }
    }

    // Notify the renderer about the mode change
    sendToUI('UI:MINI_MODE', { isMini: isMiniPlayer });
    return { isMini: isMiniPlayer };
});

// Window control handlers for custom title bar
ipcMain.handle('WINDOW:MINIMIZE', () => { if (uiWindow) uiWindow.minimize(); });
ipcMain.handle('WINDOW:MAXIMIZE', () => {
    if (!uiWindow) return;
    if (uiWindow.isMaximized()) uiWindow.unmaximize();
    else uiWindow.maximize();
});
ipcMain.handle('WINDOW:CLOSE', () => { if (uiWindow) uiWindow.close(); });

// ============================================================================
// Send data to UI
// ============================================================================

function sendToUI(channel, data) {
    if (uiWindow && !uiWindow.isDestroyed()) {
        uiWindow.webContents.send(channel, data);
    }
}

function sendLoginStatus(isLoggedIn) {
    console.log('[Main] Sending login status to UI:', isLoggedIn);
    sendToUI('UI:LOGIN_STATUS', { isLoggedIn });
}

function sendPlayerState(state) {
    console.log('[Main] sendPlayerState - track:', state.track, 'audioURL:', state.audioURL ? 'present' : 'MISSING');
    sendToUI('UI:PLAYER_STATE', state);
}

function sendStations(stations) {
    // Transform to match expected format
    const formatted = stations.map(s => ({
        id: s.stationId,
        stationId: s.stationId,
        name: s.name,
        type: 'station',
        image: PandoraAPI.getHighResArt(s.art),
        lastUpdated: s.lastPlayed || s.lastUpdated || s.dateCreated
    }));
    sendToUI('UI:COLLECTION_DATA', formatted);
}

function getCurrentState() {
    const track = currentPlaylist[currentTrackIndex];
    let currentFeedback = null;

    if (track) {
        // Debug: log track data to see audio URL field
        // console.log('[Main] Track keys:', Object.keys(track));

        // Find current track in history to get active feedback
        const histItem = songHistory.find(h => h.trackToken === track.trackToken);
        if (histItem) {
            if (histItem.feedback === 'liked') currentFeedback = 'thumbUp';
            else if (histItem.feedback === 'disliked') currentFeedback = 'thumbDown';
        }
    }

    return {
        track: track?.songTitle || null,
        artist: track?.artistName || null,
        album: track?.albumTitle || null,
        stationName: currentStation?.name || null,
        stationId: currentStation?.stationId || null,
        coverArt: PandoraAPI.getHighResArt(track?.albumArt),
        time: 0, // UI will track via audio element
        duration: track?.trackLength || 0,
        isPlaying: !!(track?.audioURL), // Auto-play when we have a valid audio URL
        trackToken: track?.trackToken || null,
        audioURL: track?.audioURL || null,
        feedback: currentFeedback, // Send current feedback to UI
        trackIndex: currentTrackIndex,
        playlistLength: currentPlaylist.length,
        history: songHistory.slice(-20) // Send last 20 played
    };
}

// ============================================================================
// API Actions
// ============================================================================

async function login(username, password) {
    console.log('[Main] Attempting login...');
    const result = await api.login(username, password);

    if (result.success) {
        sendLoginStatus(true);
        await loadStations();
    }
    // Don't sendLoginStatus(false) on failure — the UI already shows the
    // login form and will display the error inline without re-rendering.

    return result;
}

async function loadStations() {
    console.log('[Main] Loading stations...');
    const stations = await api.getStations();
    if (stations === null) {
        console.log('[Main] Station load failed (Auth error). Aborting list update.');
        return null;
    }
    currentStations = stations;
    sendStations(currentStations);
    return currentStations;
}

async function playStation(stationId, startingAtTrackId = null) {
    console.log(`[Main] Playing station: ${stationId} ${startingAtTrackId ? '(StartTrack: ' + startingAtTrackId + ')' : ''}`);

    if (currentStation) {
        // Pause the existing stream cleanly before fetching a new one
        const track = currentPlaylist[currentTrackIndex];
        if (track && track.trackToken) {
            await api.playbackPaused(currentStation.stationId, track.trackToken);
        }
    }

    currentStation = currentStations.find(s => s.stationId === stationId);
    const playlistResult = await api.getPlaylist(stationId, true, startingAtTrackId);
    currentPlaylist = playlistResult.tracks || [];
    if (playlistResult.error) {
        sendToUI('UI:ERROR', { message: playlistResult.error });
    }

    currentTrackIndex = 0;

    if (currentPlaylist.length > 0) {
        // Report track started
        const track = currentPlaylist[0];
        api.trackStarted(stationId, track.trackToken);

        // Record first track in history (cap at 50)
        if (!songHistory.length || songHistory[songHistory.length - 1].trackToken !== track.trackToken) {
            songHistory.push({
                songTitle: track.songTitle,
                artistName: track.artistName,
                albumTitle: track.albumTitle,
                coverArt: PandoraAPI.getHighResArt(track.albumArt),
                trackToken: track.trackToken,
                feedback: track.songRating === 1 ? 'liked' : null
            });
            if (songHistory.length > 50) songHistory.shift();
        }
    }

    sendPlayerState(getCurrentState());
    return getCurrentState();
}

async function skipTrack() {
    console.log('[Main] Skipping track...');
    currentTrackIndex++;

    // Prefetch when 2 tracks remain to avoid audible gaps
    if (currentTrackIndex >= currentPlaylist.length - 2 && currentStation && !isLoadingMoreTracks) {
        isLoadingMoreTracks = true;
        try {
            const result = await api.getPlaylist(currentStation.stationId, false);
            if (result.tracks?.length > 0) {
                currentPlaylist.push(...result.tracks);
            } else if (result.error) {
                // Stream was reclaimed — trim buffer to current track only
                console.log('[Main] Prefetch failed, trimming buffer:', result.error);
                currentPlaylist = currentPlaylist.slice(0, currentTrackIndex + 1);
                sendToUI('UI:ERROR', { message: 'Another device is streaming. Playback will stop after this track.' });
            }
        } finally {
            isLoadingMoreTracks = false;
        }
    }

    // No more tracks — stream was likely reclaimed by another device
    if (currentTrackIndex >= currentPlaylist.length) {
        console.log('[Main] No more tracks available — stopping playback');
        sendToUI('UI:ERROR', { message: 'Another device is streaming. Playback stopped.' });
        currentTrackIndex = Math.max(0, currentPlaylist.length - 1);
    }

    if (currentTrackIndex < currentPlaylist.length) {
        const track = currentPlaylist[currentTrackIndex];
        if (track && track.trackToken) {
            api.trackStarted(currentStation?.stationId, track.trackToken);
        }
    }

    sendPlayerState(getCurrentState());

    // Record in history (skip duplicates, cap at 50)
    const nowTrack = currentPlaylist[currentTrackIndex];
    if (nowTrack && (!songHistory.length || songHistory[songHistory.length - 1].trackToken !== nowTrack.trackToken)) {
        songHistory.push({
            songTitle: nowTrack.songTitle,
            artistName: nowTrack.artistName,
            albumTitle: nowTrack.albumTitle,
            coverArt: PandoraAPI.getHighResArt(nowTrack.albumArt),
            trackToken: nowTrack.trackToken,
            feedback: nowTrack.songRating === 1 ? 'liked' : null
        });
        if (songHistory.length > 50) songHistory.shift();
    }

    return getCurrentState();
}

async function replayTrack() {
    // Just send current state - UI will reset audio position
    sendPlayerState(getCurrentState());
    return getCurrentState();
}

async function thumbUp() {
    const track = currentPlaylist[currentTrackIndex];
    if (track?.trackToken) {
        const result = await api.addFeedback(track.trackToken, true);
        // Mark in history with feedbackId for undo
        const histItem = songHistory.find(h => h.trackToken === track.trackToken);
        if (histItem) {
            histItem.feedback = 'liked';
            histItem.feedbackId = result.feedbackId || null;
        }
        // Push updated history to UI
        sendPlayerState(getCurrentState());
    }
}

async function thumbDown() {
    const track = currentPlaylist[currentTrackIndex];
    if (track?.trackToken) {
        const result = await api.addFeedback(track.trackToken, false);
        // Mark in history with feedbackId for undo
        const histItem = songHistory.find(h => h.trackToken === track.trackToken);
        if (histItem) {
            histItem.feedback = 'disliked';
            histItem.feedbackId = result.feedbackId || null;
        }
        // Auto-skip on thumbs down
        return skipTrack();
    }
}

// ============================================================================
// IPC Handlers
// ============================================================================

// Initialize app
ipcMain.handle('APP:INIT', async () => {
    console.log('[IPC] APP:INIT');

    // Check if already logged in
    if (api.restoreAuth()) {
        console.log('[Main] Restored auth, verifying subscription...');

        const isPaid = await api.verifySubscription();
        if (!isPaid) {
            console.log('[Main] Free-tier account detected on restore — forcing logout');
            api.logout();
            sendLoginStatus(false);
            sendToUI('UI:ERROR', { message: 'Pandora Glass requires a Pandora Premium or Plus subscription.' });
            return { status: 'needsLogin' };
        }

        sendLoginStatus(true);
        await loadStations();
        return { status: 'authenticated' };
    } else {
        sendLoginStatus(false);
        return { status: 'needsLogin' };
    }
});

// Login
ipcMain.handle('AUTH:LOGIN', async (event, { username, password }) => {
    console.log('[IPC] AUTH:LOGIN');
    return await login(username, password);
});

// Logout
ipcMain.handle('AUTH:LOGOUT', async () => {
    console.log('[IPC] AUTH:LOGOUT');

    // Tell Pandora to stop the stream for this session so it doesn't hang
    const track = currentPlaylist[currentTrackIndex];
    if (currentStation && track && track.trackToken) {
        await api.playbackPaused(currentStation.stationId, track.trackToken);
    }

    api.logout();

    // Clear playback state
    currentPlaylist = [];
    currentTrackIndex = -1;
    sendPlayerState(getCurrentState());

    sendLoginStatus(false);
    return { success: true };
});

// Player commands
ipcMain.handle('PLAYER:CMD', async (event, { action, value }) => {
    console.log(`[IPC] PLAYER:CMD - Action: ${action}`);

    switch (action) {
        case 'next':
            return await skipTrack();
        case 'prev':
            return await replayTrack();
        case 'thumbUp':
            await thumbUp();
            return { success: true };
        case 'thumbDown':
            await thumbDown();
            return { success: true };
        case 'toggle':
        case 'play':
        case 'pause':
            // UI handles audio - just acknowledge
            return { success: true, action };
        case 'volume':
            return { success: true, volume: value };
        case 'seek':
            return { success: true, seek: value };
        default:
            return { success: false, error: 'Unknown action' };
    }
});

// Undo feedback
ipcMain.handle('PLAYER:UNDO_FEEDBACK', async (event, { trackToken }) => {
    console.log('[IPC] PLAYER:UNDO_FEEDBACK', trackToken);
    const histItem = songHistory.find(h => h.trackToken === trackToken);
    if (histItem && histItem.feedbackId) {
        const result = await api.deleteFeedback(histItem.feedbackId);
        if (result.success) {
            histItem.feedback = null;
            histItem.feedbackId = null;
            sendPlayerState(getCurrentState());
        }
        return result;
    }
    return { success: false, error: 'No feedback to undo' };
});

// Play a station
// Play a station or item
ipcMain.handle('NAV:PLAY_URI', async (event, payload) => {
    console.log('[IPC] NAV:PLAY_URI Payload:', JSON.stringify(payload, null, 2));
    let uri = typeof payload === 'string' ? payload : payload.uri;
    const metadata = typeof payload === 'object' ? payload : {};

    console.log(`[IPC] NAV:PLAY_URI - ${uri}`);

    // Parse URI: "type:id" or "type:prefix:id"
    const firstColon = uri.indexOf(':');
    if (firstColon === -1) return { error: 'Invalid URI format' };

    const type = uri.substring(0, firstColon);
    const id = uri.substring(firstColon + 1);

    if (type === 'station') {
        console.log(`[IPC] Station play request - ID: ${id}`);
        sendToUI('UI:LOADING', { isLoading: true });

        // Check if this station already exists in the user's collection
        const existingStation = currentStations.find(s =>
            s.stationId === id ||
            s.pandoraId === id ||
            s.stationFactoryPandoraId === id
        );

        if (existingStation) {
            console.log(`[IPC] Found existing station: ${existingStation.stationId}`);
            const result = await playStation(existingStation.stationId);
            sendToUI('UI:LOADING', { isLoading: false });
            return result;
        }

        // Try playing directly as a station ID first
        try {
            const result = await playStation(id);
            sendToUI('UI:LOADING', { isLoading: false });
            return result;
        } catch (e) {
            console.log(`[IPC] Direct play failed for ${id}, trying createStation...`);
        }

        // If direct play failed, try creating a station from this seed
        const station = await api.createStation(id);
        if (station && station.stationId) {
            await loadStations();
            const result = await playStation(station.stationId);
            sendToUI('UI:LOADING', { isLoading: false });
            return result;
        }

        console.error(`[IPC] Failed to play or create station for: ${id}`);
        sendToUI('UI:LOADING', { isLoading: false });
        return { error: 'Failed to play station' };

    } else if (type === 'song' || type === 'TR' || type === 'track' || type === 'artist') {
        // Create station from seed (Song or Artist)
        console.log(`[IPC] Creating native Pandora station from ${type}: ${id}`);
        sendToUI('UI:LOADING', { isLoading: true });
        const station = await api.createStation(id);

        if (station && station.stationId) {
            // Reload station list so it appears in sidebar
            await loadStations();

            // For songs, pass the pandoraId as startingAtTrackId so Pandora plays this exact track first
            const startTrackId = (type === 'song' || type === 'TR' || type === 'track') ? (metadata.pandoraId || id) : null;
            const result = await playStation(station.stationId, null, startTrackId);
            sendToUI('UI:LOADING', { isLoading: false });
            return result;
        }

        console.error(`[IPC] Failed to create native station for ${type}: ${id}`);
        sendToUI('UI:LOADING', { isLoading: false });
        return { error: 'Failed to create Pandora station' };
    }

    return { error: 'Unknown URI type' };
});

// Helper for 'Tune' workaround
function filterPlaylist(playlist, modeId, station) {
    if (!modeId || modeId === 'default' || !playlist.length) return playlist;

    console.log(`[Main] Workaround: Filtering playlist for mode ${modeId}`);

    if (modeId === 'artist_only') {
        // Try to guess station artist
        let targetArtist = null;
        if (station.name.endsWith(' Radio')) {
            targetArtist = station.name.replace(' Radio', '');
        }

        if (targetArtist) {
            console.log(`[Main] Filtering for artist: "${targetArtist}"`);
            const filtered = playlist.filter(track => {
                // Fuzzy match artist name
                return track.artistName && track.artistName.toLowerCase().includes(targetArtist.toLowerCase());
            });

            if (filtered.length > 0) {
                console.log(`[Main] Filtered ${playlist.length} -> ${filtered.length} tracks`);
                return filtered;
            }
            console.log('[Main] Filter returned 0 tracks, reverting to original');
        }
    }

    return playlist;
}

// Search
ipcMain.handle('CONTENT:SEARCH', async (event, query) => {
    console.log(`[IPC] CONTENT:SEARCH - ${query}`);
    const results = await api.search(query);
    // Send results to renderer
    sendToUI('UI:SEARCH_RESULTS', results);
    return results;
});

ipcMain.handle('CONTENT:REMOVE_STATION', async (event, id) => {
    console.log(`[IPC] CONTENT:REMOVE_STATION - ${id}`);
    const success = await api.removeStation(id);
    if (success) {
        // Refresh stations using the centralized loader
        await loadStations();
    }
    return success;
});

// Fetch lyrics via Node env to bypass CORS
ipcMain.handle('CONTENT:FETCH_LYRICS', async (event, artist, title) => {
    try {
        const getUrl = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`;
        console.log(`[Main] Fetching lyrics from: ${getUrl}`);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        let response = await fetch(getUrl, {
            headers: { 'User-Agent': 'PandoraGlass/1.0.0 (https://github.com/mitchell/pandora-glass)' },
            signal: controller.signal
        });
        clearTimeout(timeout);

        if (response.ok) {
            const json = await response.json();
            return { success: true, lyrics: json.syncedLyrics || json.plainLyrics || 'Lyrics not found.' };
        }

        // Fallback to fuzzy search if exact match fails
        if (response.status === 404) {
            const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(artist + ' ' + title)}`;
            console.log(`[Main] Exact match failed. Falling back to fuzzy search: ${searchUrl}`);

            const searchController = new AbortController();
            const searchTimeout = setTimeout(() => searchController.abort(), 10000);

            let searchResponse = await fetch(searchUrl, {
                headers: { 'User-Agent': 'PandoraGlass/1.0.0 (https://github.com/mitchell/pandora-glass)' },
                signal: searchController.signal
            });
            clearTimeout(searchTimeout);

            if (searchResponse.ok) {
                const results = await searchResponse.json();
                if (results && results.length > 0) {
                    // Find the best match that actually has lyrics attached
                    const bestMatch = results.find(r => r.syncedLyrics || r.plainLyrics);
                    if (bestMatch) {
                        return { success: true, lyrics: bestMatch.syncedLyrics || bestMatch.plainLyrics };
                    }
                }
            }
            return { success: false, error: 'Lyrics not found for this track.' };
        }

        return { success: false, error: `Lyrics service unavailable (Error ${response.status}).` };

    } catch (e) {
        console.error('[Main] Lyrics fetch error:', e);
        return { success: false, error: 'Network error while fetching lyrics.' };
    }
});

// Get more tracks
ipcMain.handle('PLAYER:GET_MORE_TRACKS', async () => {
    if (!currentStation) return { tracks: [] };

    const result = await api.getPlaylist(currentStation.stationId, false);
    const moreTracks = result.tracks || [];
    currentPlaylist.push(...moreTracks);

    if (moreTracks.length === 0 && result.error) {
        sendToUI('UI:ERROR', { message: 'Another device is streaming. Playback will stop after this track.' });
    }

    return {
        tracks: moreTracks.map(t => ({
            audioURL: t.audioURL,
            title: t.songTitle,
            artist: t.artistName,
            album: t.albumTitle,
            duration: t.trackLength,
            coverArt: PandoraAPI.getHighResArt(t.albumArt),
            trackToken: t.trackToken
        }))
    };
});

// ============================================================================
// App Lifecycle
// ============================================================================

app.whenReady().then(() => {
    // Initialize API
    api = new PandoraAPI();

    // Handle session expiration
    api.onSessionExpired = () => {
        console.log('[Main] Session expired handler triggered! Forcing logout...');
        api.logout(); // Clears config and tokens
        sendLoginStatus(false);
    };

    createUIWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createUIWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// Handle certificate errors for development only
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    if (!app.isPackaged) {
        event.preventDefault();
        callback(true);
    } else {
        callback(false);
    }
});
