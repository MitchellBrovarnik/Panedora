/**
 * Pandora Glass v2 - Main Process
 * Direct API-based architecture (no hidden browser)
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

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

// ============================================================================
// Window Creation
// ============================================================================

function createUIWindow() {
    uiWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        frame: true,
        backgroundColor: '#121212',
        titleBarStyle: 'hiddenInset',
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

    // Debug: log track data to see audio URL field
    if (track) {
        console.log('[Main] Track keys:', Object.keys(track));
        console.log('[Main] Audio URL:', track.audioURL);
        console.log('[Main] Audio URL Alt:', track.audioUrlMap);
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
    currentPlaylist = await api.getPlaylist(stationId, true, startingAtTrackId);

    currentTrackIndex = 0;

    if (currentPlaylist.length > 0) {
        // Report track started
        const track = currentPlaylist[0];
        api.trackStarted(stationId, track.trackToken);

        // Record first track in history
        if (!songHistory.length || songHistory[songHistory.length - 1].trackToken !== track.trackToken) {
            songHistory.push({
                songTitle: track.songTitle,
                artistName: track.artistName,
                albumTitle: track.albumTitle,
                coverArt: PandoraAPI.getHighResArt(track.albumArt),
                trackToken: track.trackToken,
                feedback: null
            });
        }
    }

    sendPlayerState(getCurrentState());
    return getCurrentState();
}

async function skipTrack() {
    console.log('[Main] Skipping track...');
    currentTrackIndex++;

    // Need more tracks?
    if (currentTrackIndex >= currentPlaylist.length - 1 && currentStation) {
        const moreTracks = await api.getPlaylist(currentStation.stationId, false);
        currentPlaylist.push(...moreTracks);
    }

    if (currentTrackIndex < currentPlaylist.length) {
        const track = currentPlaylist[currentTrackIndex];
        if (track && track.trackToken) {
            api.trackStarted(currentStation?.stationId, track.trackToken);
        }
    }

    sendPlayerState(getCurrentState());

    // Record in history (skip duplicates)
    const nowTrack = currentPlaylist[currentTrackIndex];
    if (nowTrack && (!songHistory.length || songHistory[songHistory.length - 1].trackToken !== nowTrack.trackToken)) {
        songHistory.push({
            songTitle: nowTrack.songTitle,
            artistName: nowTrack.artistName,
            albumTitle: nowTrack.albumTitle,
            coverArt: PandoraAPI.getHighResArt(nowTrack.albumArt),
            trackToken: nowTrack.trackToken,
            feedback: null // null = no feedback, 'liked', 'disliked'
        });
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
        console.log('[Main] Restored auth, loading stations...');
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

// Get more tracks
ipcMain.handle('PLAYER:GET_MORE_TRACKS', async () => {
    if (!currentStation) return { tracks: [] };

    const moreTracks = await api.getPlaylist(currentStation.stationId, false);
    currentPlaylist.push(...moreTracks);

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

// Handle certificate errors for development
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    event.preventDefault();
    callback(true);
});
