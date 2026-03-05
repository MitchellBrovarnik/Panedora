/**
 * Panedora - Main Process
 * Direct API-based architecture (no hidden browser)
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');

// Disable GPU caching to prevent 'Access is denied' cache_util_win errors on Windows startup
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-gpu-disk-cache');

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
let streamReclaimed = false;

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
    sendToUI('UI:LOGIN_STATUS', { isLoggedIn });
}

function sendPlayerState(state) {
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
    const stations = await api.getStations();
    if (stations === null) {
        return null;
    }
    currentStations = stations;
    sendStations(currentStations);
    return currentStations;
}

async function playStation(stationId, startingAtTrackId = null) {
    if (currentStation) {
        // Pause the existing stream cleanly before fetching a new one
        const track = currentPlaylist[currentTrackIndex];
        if (track && track.trackToken) {
            await api.playbackPaused(currentStation.stationId, track.trackToken);
        }
    }

    currentStation = currentStations.find(s => s.stationId === stationId);
    streamReclaimed = false;
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
    // If stream was already reclaimed, block the skip immediately
    if (streamReclaimed) {
        sendToUI('UI:ERROR', { message: 'Another device is streaming. Playback stopped.' });
        return getCurrentState();
    }

    currentTrackIndex++;

    // Prefetch when 2 tracks remain (fast-fail — no 12s retry for background fetches)
    if (currentTrackIndex >= currentPlaylist.length - 2 && currentStation && !isLoadingMoreTracks) {
        isLoadingMoreTracks = true;
        try {
            const result = await api.getPlaylist(currentStation.stationId, false, null, { skipRetry: true });
            if (result.tracks?.length > 0) {
                currentPlaylist.push(...result.tracks);
            } else if (result.error) {
                // Stream was reclaimed — trim buffer and flag it
                streamReclaimed = true;
                currentPlaylist = currentPlaylist.slice(0, currentTrackIndex + 1);
            }
        } finally {
            isLoadingMoreTracks = false;
        }
    }

    // No more tracks left
    if (currentTrackIndex >= currentPlaylist.length) {
        streamReclaimed = true;
        if (currentPlaylist.length === 0) {
            currentTrackIndex = 0;
            sendToUI('UI:ERROR', { message: 'No tracks available.' });
            return getCurrentState();
        }
        sendToUI('UI:ERROR', { message: 'Another device is streaming. Playback stopped.' });
        currentTrackIndex = currentPlaylist.length - 1;
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
    try {
        // Check if already logged in
        if (api.restoreAuth()) {
           const isPaid = await api.verifySubscription();
            if (!isPaid) {
                api.logout();
                sendLoginStatus(false);
                sendToUI('UI:ERROR', { message: 'Panedora requires a Pandora Premium or Plus subscription.' });
                return { status: 'needsLogin' };
            }

            sendLoginStatus(true);
            await loadStations();
            return { status: 'authenticated' };
        } else {
            sendLoginStatus(false);
            return { status: 'needsLogin' };
        }
    } catch (err) {
        console.error('[Main] APP:INIT error:', err);
        sendLoginStatus(false);
        return { status: 'needsLogin' };
    }
});

// Login
ipcMain.handle('AUTH:LOGIN', async (event, { username, password }) => {
    try {
        return await login(username, password);
    } catch (err) {
        console.error('[Main] AUTH:LOGIN error:', err);
        return { error: 'Login failed. Please try again.' };
    }
});

// Logout
ipcMain.handle('AUTH:LOGOUT', async () => {
    try {
        // Tell Pandora to stop the stream for this session so it doesn't hang
        const track = currentPlaylist[currentTrackIndex];
        if (currentStation && track && track.trackToken) {
            await api.playbackPaused(currentStation.stationId, track.trackToken);
        }

        api.logout();
    } catch (err) {
        console.error('[Main] AUTH:LOGOUT error:', err);
    }

    // Clear playback state
    currentPlaylist = [];
    currentTrackIndex = -1;
    sendPlayerState(getCurrentState());

    sendLoginStatus(false);
    return { success: true };
});

// Player commands
ipcMain.handle('PLAYER:CMD', async (event, { action, value }) => {
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

// Play a station or item
ipcMain.handle('NAV:PLAY_URI', async (event, payload) => {
    let uri = typeof payload === 'string' ? payload : payload.uri;
    const metadata = typeof payload === 'object' ? payload : {};

    // Parse URI: "type:id" or "type:prefix:id"
    const firstColon = uri.indexOf(':');
    if (firstColon === -1) return { error: 'Invalid URI format' };

    const type = uri.substring(0, firstColon);
    const id = uri.substring(firstColon + 1);

    if (type === 'station') {
        sendToUI('UI:LOADING', { isLoading: true });

        // Check if this station already exists in the user's collection
        const existingStation = currentStations.find(s =>
            s.stationId === id ||
            s.pandoraId === id ||
            s.stationFactoryPandoraId === id
        );

        if (existingStation) {
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
            // Direct play failed, try creating a station from this seed
        }

        // If direct play failed, try creating a station from this seed
        const station = await api.createStation(id);
        if (station && station.stationId) {
            await loadStations();
            const result = await playStation(station.stationId);
            sendToUI('UI:LOADING', { isLoading: false });
            return result;
        }

        sendToUI('UI:LOADING', { isLoading: false });
        return { error: 'Failed to play station' };

    } else if (type === 'song' || type === 'TR' || type === 'track' || type === 'artist') {
        sendToUI('UI:LOADING', { isLoading: true });
        const station = await api.createStation(id);

        if (station && station.stationId) {
            // Reload station list so it appears in sidebar
            await loadStations();

            // For songs, pass the pandoraId as startingAtTrackId so Pandora plays this exact track first
            const startTrackId = (type === 'song' || type === 'TR' || type === 'track') ? (metadata.pandoraId || id) : null;
            const result = await playStation(station.stationId, startTrackId);
            sendToUI('UI:LOADING', { isLoading: false });
            return result;
        }

        sendToUI('UI:LOADING', { isLoading: false });
        return { error: 'Failed to create Pandora station' };
    }

    return { error: 'Unknown URI type' };
});

// Search
ipcMain.handle('CONTENT:SEARCH', async (event, query) => {
    const results = await api.search(query);
    // Send results to renderer
    sendToUI('UI:SEARCH_RESULTS', results);
    return results;
});

ipcMain.handle('CONTENT:REMOVE_STATION', async (event, id) => {
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

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        let response = await fetch(getUrl, {
            headers: { 'User-Agent': 'Panedora/1.0.0' },
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

            const searchController = new AbortController();
            const searchTimeout = setTimeout(() => searchController.abort(), 10000);

            let searchResponse = await fetch(searchUrl, {
                headers: { 'User-Agent': 'Panedora/1.0.0' },
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

    const result = await api.getPlaylist(currentStation.stationId, false, null, { skipRetry: true });
    const moreTracks = result.tracks || [];
    currentPlaylist.push(...moreTracks);

    if (moreTracks.length === 0 && result.error) {
        streamReclaimed = true;
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
        api.logout();
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
