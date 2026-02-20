/**
 * Pandora Glass v2 - Main Process
 * Direct API-based architecture (no hidden browser)
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const musicFallback = require('./music-fallback');

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
let stationSyncInterval = null;

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
        name: s.name,
        type: 'station',
        image: PandoraAPI.getHighResArt(s.art)
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
        time: 0, // UI will track via audio element
        duration: track?.trackLength || 0,
        isPlaying: false, // UI will track
        trackToken: track?.trackToken || null,
        audioURL: track?.audioURL || null,
        audioReceiptURL: track?.audioReceiptURL || null,
        trackIndex: currentTrackIndex,
        playlistLength: currentPlaylist.length
    };
}


async function prepareCurrentTrackForPlayback() {
    const track = currentPlaylist[currentTrackIndex];
    if (!track) return;

    await api.prepareStream(track, currentStation?.stationId || null);
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
        startStationSync();
    } else {
        sendLoginStatus(false);
        stopStationSync();
    }

    return result;
}

async function loadStations() {
    console.log('[Main] Loading stations...');
    currentStations = await api.getStations();
    sendStations(currentStations);
    return currentStations;
}

async function syncStationsInBackground() {
    if (!api?.isAuthenticated()) return;

    try {
        const previousCount = currentStations.length;
        const stations = await loadStations();
        if (stations.length !== previousCount) {
            console.log(`[Main] Station sync updated count: ${previousCount} -> ${stations.length}`);
        }
    } catch (error) {
        console.error('[Main] Background station sync failed:', error);
    }
}

function startStationSync() {
    if (stationSyncInterval) clearInterval(stationSyncInterval);

    // Keep station list synced with changes from other devices/Pandora web.
    stationSyncInterval = setInterval(() => {
        syncStationsInBackground();
    }, 60000);

    // Run an early sync shortly after auth restore/login.
    setTimeout(() => {
        syncStationsInBackground();
    }, 5000);
}

function stopStationSync() {
    if (!stationSyncInterval) return;
    clearInterval(stationSyncInterval);
    stationSyncInterval = null;
}

async function playStation(stationId, modeId = null) {
    console.log(`[Main] Playing station: ${stationId} ${modeId ? '(Mode: ' + modeId + ')' : ''}`);

    currentStation = currentStations.find(s => s.stationId === stationId);
    currentPlaylist = await api.getPlaylist(stationId, true, modeId);
    // Filter playlist based on mode (Workaround)
    if (modeId) {
        currentPlaylist = filterPlaylist(currentPlaylist, modeId, currentStation);
    }

    // If filter removed everything, fetch more (fallback) -> Not implemented yet to avoid loops

    currentTrackIndex = 0;

    if (currentPlaylist.length > 0) {
        await prepareCurrentTrackForPlayback();
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
        await prepareCurrentTrackForPlayback();
    }

    sendPlayerState(getCurrentState());
    return getCurrentState();
}

async function replayTrack() {
    await prepareCurrentTrackForPlayback();
    // Just send current state - UI will reset audio position
    sendPlayerState(getCurrentState());
    return getCurrentState();
}

async function thumbUp() {
    const track = currentPlaylist[currentTrackIndex];
    if (track?.trackToken) {
        await api.addFeedback(track.trackToken, true);
    }
}

async function thumbDown() {
    const track = currentPlaylist[currentTrackIndex];
    if (track?.trackToken) {
        await api.addFeedback(track.trackToken, false);
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
        startStationSync();
        return { status: 'authenticated' };
    } else {
        sendLoginStatus(false);
        stopStationSync();
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
    stopStationSync();
    api.logout();
    sendLoginStatus(false);
    return { success: true };
});

ipcMain.handle('CONTENT:REFRESH_STATIONS', async () => {
    console.log('[IPC] CONTENT:REFRESH_STATIONS');
    return await loadStations();
});


ipcMain.handle('PLAYER:PREPARE_STREAM', async () => {
    await prepareCurrentTrackForPlayback();
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
        case 'tune':
            console.log(`[IPC] PLAYER:CMD - Tune Station Mode: ${value}`);
            if (currentStation) {
                // Try to play with mode directly (skip transform as it's unreliable)
                console.log(`[IPC] Tuning to station ${currentStation.stationId} (Mode: ${value})`);
                await playStation(currentStation.stationId, value);
            }
            return { success: true, mode: value };
        default:
            return { success: false, error: 'Unknown action' };
    }
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

    const type = uri.substring(0, firstColon); // 'song', 'station', 'TR', 'TR:123'
    const id = uri.substring(firstColon + 1);

    if (type === 'station') {
        return await playStation(id);
    } else if (type === 'song' || type === 'TR' || type === 'track' || type === 'artist') {

        // Try YouTube Fallback for Songs
        const songTitle = metadata.name || metadata.title;
        if ((type === 'song' || type === 'TR' || type === 'track') && songTitle && metadata.artist) {
            console.log(`[Main] Attempting YouTube fallback for: ${songTitle} - ${metadata.artist}`);
            try {
                const query = `${metadata.artist} ${songTitle} audio`;
                const searchResult = await musicFallback.search(query);

                if (searchResult) {
                    const streamUrl = await musicFallback.getStreamUrl(searchResult.videoId);
                    if (streamUrl) {
                        console.log(`[Main] Found fallback stream: ${streamUrl}`);

                        // Create station in background so it appears in list
                        api.createStation(id).then(async (s) => {
                            if (s) {
                                console.log('[Main] Background station created:', s.stationId);
                                const newStations = await loadStations(); // Refresh list

                                // OPTIONAL: Auto-queue station tracks after this song?
                                // For now, let's just create it so user can click it.
                            }
                        });

                        // Construct fake track
                        const fakeTrack = {
                            songTitle: songTitle,
                            artistName: metadata.artist,
                            albumTitle: 'On Demand (via YouTube)',
                            albumArt: metadata.image ? [{ url: metadata.image }] : [],
                            audioURL: streamUrl,
                            trackLength: searchResult.lengthSeconds || 0,
                            trackToken: null,
                            identity: 'youtube'
                        };

                        currentPlaylist = [fakeTrack];
                        currentTrackIndex = 0;
                        // Use a fake station container
                        currentStation = {
                            stationId: 'youtube-' + id,
                            name: `Song: ${songTitle}`,
                            art: metadata.image ? [{ url: metadata.image }] : []
                        };

                        sendPlayerState(getCurrentState());
                        sendToUI('UI:LOADING', { isLoading: false }); // Stop loading
                        return { success: true };
                    }
                }
            } catch (e) {
                console.error('[Main] Fallback failed:', e);
            }
            sendToUI('UI:LOADING', { isLoading: false }); // Stop loading regardless of error
        }

        // Fallback or Artist: Create station from seed
        console.log(`[IPC] Creating station from ${type}: ${id}`);
        sendToUI('UI:LOADING', { isLoading: true });
        const station = await api.createStation(id);

        if (station && station.stationId) {
            // Reload station list to include new station
            await loadStations();
            // Play the new station
            const result = await playStation(station.stationId);
            sendToUI('UI:LOADING', { isLoading: false });
            return result;
        }
        sendToUI('UI:LOADING', { isLoading: false });
        return { error: 'Failed to create station' };
    }

    return { error: 'Unknown type' };
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

    createUIWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createUIWindow();
        }
    });
});

app.on('window-all-closed', () => {
    stopStationSync();
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// Handle certificate errors for development
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    event.preventDefault();
    callback(true);
});
