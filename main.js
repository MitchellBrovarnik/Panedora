/**
 * Panedora - Main Process
 * Direct API-based architecture (no hidden browser)
 */

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');

// Disable GPU caching to prevent 'Access is denied' cache_util_win errors on Windows startup
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-gpu-disk-cache');

const PandoraAPI = require('./pandora-api');
const config = require('./config');
const { PandoraVerification } = require('./pandora-verification');
const verification = new PandoraVerification();

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
let isPaused = false; // Track pause state so we don't force-play on state updates
let playbackGeneration = 0;
let streamPrompt = null;
let pauseRevision = 0;
let resumeOperation = null;
let skipOperation = null;
let stationLoading = false;
let stationModes = emptyStationModes();
let stationModesRead = null;
let stationModeChange = null;

function emptyStationModes() {
    return { status: 'idle', available: false, modes: [], currentModeId: null, error: null };
}

function resetStationModes() {
    stationModes = emptyStationModes();
    stationModesRead = null;
    stationModeChange = null;
}

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

    uiWindow.loadFile(path.join(__dirname, 'index.html'));

    if (process.argv.includes('--dev')) {
        uiWindow.webContents.openDevTools();
    }

    uiWindow.on('closed', () => {
        playbackGeneration++;
        verification.cancel();
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
        uiWindow.setMinimumSize(480, 70);
        uiWindow.setSize(540, 80);
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

function isShuffleStation(station) {
    return station?.isShuffle === true || station?.isQuickMix === true ||
        station?.stationType === 'QUICKMIX' ||
        ['Shuffle', 'QuickMix', 'Shuffle Stations'].includes(station?.name);
}

function sendStations(stations) {
    // Transform to match expected format
    const formatted = stations.map(s => ({
        id: s.stationId,
        stationId: s.stationId,
        name: s.name,
        isShuffle: isShuffleStation(s),
        type: 'station',
        image: PandoraAPI.getHighResArt(s.art),
        lastUpdated: s.lastPlayed || s.lastUpdated || s.dateCreated
    }));
    sendToUI('UI:COLLECTION_DATA', formatted);
}

function getCurrentState() {
    const track = currentPlaylist[currentTrackIndex];
    const currentFeedback = feedbackForTrack(track);

    return {
        track: track?.songTitle || null,
        artist: track?.artistName || null,
        album: track?.albumTitle || null,
        stationName: currentStation?.name || null,
        stationId: currentStation?.stationId || null,
        isShuffle: isShuffleStation(currentStation),
        stationLoading,
        stationModes: { ...stationModes, changing: stationModeChange?.generation === playbackGeneration },
        coverArt: PandoraAPI.getHighResArt(track?.albumArt),
        time: 0, // UI will track via audio element
        duration: track?.trackLength || 0,
        isPlaying: !!(track?.audioURL) && !isPaused && !streamReclaimed,
        trackToken: track?.trackToken || null,
        audioURL: streamReclaimed ? null : track?.audioURL || null,
        streamBlocked: streamReclaimed,
        feedback: currentFeedback, // Send current feedback to UI
        trackIndex: currentTrackIndex,
        playlistLength: currentPlaylist.length,
        history: songHistory.slice(-20) // Send last 20 played
    };
}

function feedbackForTrack(track) {
    // REST playlists use rating; older playlist formats use songRating.
    const rating = Number(track?.rating ?? track?.songRating);
    if (rating === 1) return 'thumbUp';
    if (rating === -1) return 'thumbDown';
    return null;
}

function rememberTrack(track) {
    if (!track || songHistory[songHistory.length - 1]?.trackToken === track.trackToken) return;
    const feedback = feedbackForTrack(track);
    songHistory.push({
        songTitle: track.songTitle,
        artistName: track.artistName,
        albumTitle: track.albumTitle,
        coverArt: PandoraAPI.getHighResArt(track.albumArt),
        trackToken: track.trackToken,
        feedbackId: track.feedbackId || null,
        feedback: feedback === 'thumbUp' ? 'liked' : feedback === 'thumbDown' ? 'disliked' : null
    });
    if (songHistory.length > 50) songHistory.shift();
}

function showStreamConflict(stationId, generation = playbackGeneration) {
    if (generation !== playbackGeneration || currentStation?.stationId !== stationId) return Promise.resolve();
    streamReclaimed = true;
    isPaused = true;
    sendPlayerState(getCurrentState());
    if (streamPrompt) {
        if (streamPrompt.generation === generation) return streamPrompt.promise;
        // A prior station's dialog cannot make the choice for this station.
        return streamPrompt.promise.then(() => showStreamConflict(stationId, generation));
    }
    if (!uiWindow || uiWindow.isDestroyed()) return Promise.resolve();

    const prompt = { generation };
    streamPrompt = prompt;
    prompt.promise = (async () => {
        try {
            // Native modal dialogs remain usable in the compact mini player.
            const { response } = await dialog.showMessageBox(uiWindow, {
                type: 'question',
                title: 'Someone else is listening',
                message: 'Your Pandora account is playing on another device.',
                detail: 'Choose Let me listen to continue in Panedora, or Let them listen to keep this app paused.',
                buttons: ['Let me listen', 'Let them listen'],
                defaultId: 1,
                cancelId: 1,
                noLink: true
            });
            if (response !== 0 || generation !== playbackGeneration ||
                !uiWindow || uiWindow.isDestroyed()) return;

            const resumed = await api.playbackResumed(true);
            if (generation !== playbackGeneration) return;
            if (!resumed.success) {
                sendToUI('UI:ERROR', { message: resumed.error });
                return;
            }
            const result = await api.getPlaylist(stationId, true);
            if (generation !== playbackGeneration) return;
            if (result.streamConflict || result.error || !result.tracks?.length) {
                sendToUI('UI:ERROR', { message: result.error || 'No tracks available. Please try playing the station again.' });
                return;
            }
            // Discard playlist responses requested before this successful takeover.
            playbackGeneration++;
            isLoadingMoreTracks = false;
            resetStationModes();
            currentPlaylist = result.tracks;
            currentTrackIndex = 0;
            streamReclaimed = false;
            isPaused = false;
            rememberTrack(currentPlaylist[0]);
            api.trackStarted(stationId, currentPlaylist[0].trackToken);
            sendPlayerState(getCurrentState());
        } catch (error) {
            if (generation === playbackGeneration) {
                sendToUI('UI:ERROR', { message: 'Could not switch playback to Panedora. Please try again.' });
            }
        } finally {
            if (streamPrompt === prompt) streamPrompt = null;
        }
    })();
    return prompt.promise;
}

async function resumePlayer() {
    if (stationLoading) return { success: false };
    if (!currentStation) return { success: false, error: 'Select a station first.' };
    if (streamReclaimed) {
        await showStreamConflict(currentStation.stationId);
        return { success: !streamReclaimed && !isPaused };
    }
    if (!currentPlaylist[currentTrackIndex]?.audioURL) {
        await playStation(currentStation.stationId);
        return { success: !isPaused && !streamReclaimed };
    }
    if (!isPaused) return { success: true };
    if (resumeOperation?.generation === playbackGeneration) return resumeOperation.promise;
    const operation = { generation: playbackGeneration, pauseRevision };
    resumeOperation = operation;
    operation.promise = (async () => {
        try {
            const result = await api.playbackResumed(false);
            if (operation.generation !== playbackGeneration) return { success: false };
            // A later pause must win over a slow resume response.
            if (operation.pauseRevision !== pauseRevision) {
                if (result.success && isPaused && !streamReclaimed) {
                    await api.playbackPaused(currentStation.stationId, currentPlaylist[currentTrackIndex]?.trackToken);
                }
                return { success: false };
            }
            if (result.streamConflict) {
                await showStreamConflict(currentStation.stationId, operation.generation);
                return { success: !streamReclaimed && !isPaused };
            }
            if (!result.success) {
                isPaused = true;
                sendPlayerState({ ...getCurrentState(), pausePlayback: true });
                sendToUI('UI:ERROR', { message: result.error });
                return result;
            }
            isPaused = false;
            sendPlayerState({ ...getCurrentState(), resumePlayback: true });
            return { success: true };
        } finally {
            if (resumeOperation === operation) resumeOperation = null;
        }
    })();
    return operation.promise;
}

async function pausePlayer() {
    pauseRevision++;
    const wasPlaying = !isPaused && !streamReclaimed;
    isPaused = true;
    const track = currentPlaylist[currentTrackIndex];
    if (wasPlaying && currentStation && track?.trackToken) {
        await api.playbackPaused(currentStation.stationId, track.trackToken);
    }
    return { success: true };
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

async function restoreSavedSession() {
    const creds = config.getCredentials();
    if (!creds?.email || !creds?.password) {
        return { success: false, error: 'No saved credentials found.' };
    }

    console.log('[Main] Attempting sign-in with saved credentials...');
    const result = await login(creds.email, creds.password);
    if (!result.success) {
        console.error('[Main] Saved-credential sign-in failed:', result.error || 'Unknown error');
    }
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
    const generation = ++playbackGeneration;
    stationLoading = true;
    resetStationModes();
    isLoadingMoreTracks = false;
    const previousTrack = currentPlaylist[currentTrackIndex];
    isPaused = true;
    sendPlayerState({ ...getCurrentState(), pausePlayback: true });
    if (!streamReclaimed && currentStation && previousTrack?.trackToken) {
        await api.playbackPaused(currentStation.stationId, previousTrack.trackToken);
    }
    if (generation !== playbackGeneration) return getCurrentState();
    currentStation = currentStations.find(s => s.stationId === stationId) || { stationId };
    streamReclaimed = false;
    currentPlaylist = [];
    currentTrackIndex = 0;
    sendPlayerState(getCurrentState());
    const result = await api.getPlaylist(stationId, true, startingAtTrackId);
    if (generation !== playbackGeneration) return getCurrentState();
    stationLoading = false;
    if (result.streamConflict) {
        await showStreamConflict(stationId, generation);
        return getCurrentState();
    }
    currentPlaylist = result.tracks || [];
    isPaused = currentPlaylist.length === 0;
    if (result.error) sendToUI('UI:ERROR', { message: result.error });
    if (currentPlaylist.length) {
        rememberTrack(currentPlaylist[0]);
        api.trackStarted(stationId, currentPlaylist[0].trackToken);
    }
    sendPlayerState(getCurrentState());
    return getCurrentState();
}

function skipTrack() {
    if (streamReclaimed || stationLoading) return Promise.resolve(getCurrentState());
    if (skipOperation?.generation === playbackGeneration) return skipOperation.promise;
    const operation = { generation: playbackGeneration, pauseRevision, track: currentPlaylist[currentTrackIndex] };
    skipOperation = operation;
    operation.promise = (async () => {
        // A natural song ending during a mode change must wait for the fresh mix.
        if (stationModeChange?.generation === operation.generation) await stationModeChange.promise;
        if (operation.generation !== playbackGeneration || streamReclaimed ||
            currentPlaylist[currentTrackIndex] !== operation.track) return getCurrentState();
        return advanceTrack(operation.generation, operation.pauseRevision);
    })().finally(() => {
        if (skipOperation === operation) skipOperation = null;
    });
    return operation.promise;
}

async function advanceTrack(generation, requestedPauseRevision) {
    const nextIndex = currentTrackIndex + 1;
    if (nextIndex >= currentPlaylist.length - 2 && currentStation && !isLoadingMoreTracks) {
        isLoadingMoreTracks = true;
        try {
            const result = await api.getPlaylist(currentStation.stationId);
            if (generation !== playbackGeneration) return getCurrentState();
            if (result.streamConflict) {
                await showStreamConflict(currentStation.stationId, generation);
                return getCurrentState();
            }
            if (result.tracks?.length) currentPlaylist.push(...result.tracks);
            else if (result.error) sendToUI('UI:ERROR', { message: result.error });
        } finally {
            if (generation === playbackGeneration) isLoadingMoreTracks = false;
        }
    }
    if (nextIndex >= currentPlaylist.length) {
        isPaused = true;
        sendToUI('UI:ERROR', { message: 'No more tracks available. Please try playing the station again.' });
        sendPlayerState({ ...getCurrentState(), pausePlayback: true });
        return getCurrentState();
    }
    currentTrackIndex = nextIndex;
    if (requestedPauseRevision === pauseRevision) isPaused = false;
    const track = currentPlaylist[currentTrackIndex];
    rememberTrack(track);
    if (track?.trackToken) api.trackStarted(currentStation?.stationId, track.trackToken);
    sendPlayerState(getCurrentState());
    return getCurrentState();
}

// Modes are loaded only when the expanded song/history view requests them.
async function loadStationModes(stationId) {
    if (!currentStation || isShuffleStation(currentStation) || stationId !== currentStation.stationId || stationLoading || streamReclaimed) {
        return { success: false };
    }
    if (stationModeChange?.generation === playbackGeneration) return { success: false };
    if (stationModesRead?.generation === playbackGeneration) return stationModesRead.promise;
    const operation = { generation: playbackGeneration };
    stationModesRead = operation;
    stationModes = { ...stationModes, status: 'loading', error: null };
    sendPlayerState(getCurrentState());
    operation.promise = (async () => {
        try {
            const result = await api.getStationModes(stationId);
            if (operation.generation !== playbackGeneration || stationModesRead !== operation) return { success: false };
            stationModes = result.success
                ? { ...result, status: 'ready', error: null }
                : { ...emptyStationModes(), status: 'error', error: result.error };
            sendPlayerState(getCurrentState());
            if (result.streamConflict) await showStreamConflict(stationId, operation.generation);
            return result;
        } catch {
            const result = { success: false, error: 'Could not load station modes. Please try again.' };
            if (operation.generation === playbackGeneration && stationModesRead === operation) {
                stationModes = { ...emptyStationModes(), status: 'error', error: result.error };
                sendPlayerState(getCurrentState());
            }
            return result;
        } finally {
            if (stationModesRead === operation) stationModesRead = null;
        }
    })();
    return operation.promise;
}

function changeStationMode(stationId, modeId) {
    if (!currentStation || isShuffleStation(currentStation) || stationId !== currentStation.stationId || stationLoading || streamReclaimed ||
        stationModeChange?.generation === playbackGeneration || stationModes.status !== 'ready') {
        return Promise.resolve({ success: false, error: 'Wait for the station to be ready, then try again.' });
    }
    const mode = stationModes.modes.find(item => item.id === modeId);
    if (!stationModes.available || !mode?.available) {
        return Promise.resolve({ success: false, error: 'That mode is not available on this station.' });
    }
    if (stationModes.currentModeId === modeId) return Promise.resolve({ success: true });

    const operation = { generation: ++playbackGeneration, pauseRevision };
    stationModeChange = operation;
    stationModesRead = null;
    isLoadingMoreTracks = false;
    stationModes = { ...stationModes, error: null };
    // Discard the old queue immediately, but keep the current audio until the
    // requested mode and a fresh playable track have both been confirmed.
    currentPlaylist = currentPlaylist.slice(0, currentTrackIndex + 1);
    sendPlayerState(getCurrentState());
    const isCurrent = () => operation.generation === playbackGeneration && !streamReclaimed;
    operation.promise = (async () => {
        try {
            const result = await api.setStationMode(stationId, modeId);
            if (!isCurrent()) return { success: false };
            if (result.streamConflict) {
                await showStreamConflict(stationId, operation.generation);
                return { success: false };
            }
            if (!result.success) {
                // A lost response may have applied the change on Pandora. Read
                // back the actual mode; never keep an optimistic selection.
                const actual = result.modes ? result : await api.getStationModes(stationId);
                if (!isCurrent()) return { success: false };
                stationModes = actual.modes
                    ? { ...actual, status: 'ready', error: result.error }
                    : { ...emptyStationModes(), status: 'error', error: result.error };
                if (actual.streamConflict) await showStreamConflict(stationId, operation.generation);
                return { success: false };
            }

            // Continue the existing station, rather than starting it again (which
            // can reset its tuning). Do not play from the previous queued mix.
            const playlist = await api.getPlaylist(stationId, false);
            if (!isCurrent()) return { success: false };
            if (playlist.streamConflict) {
                await showStreamConflict(stationId, operation.generation);
                return { success: false };
            }
            const confirmed = await api.getStationModes(stationId);
            if (!isCurrent()) return { success: false };
            if (confirmed.streamConflict) {
                await showStreamConflict(stationId, operation.generation);
                return { success: false };
            }
            if (!confirmed.success) {
                stationModes = { ...emptyStationModes(), status: 'error', error: confirmed.error };
                return { success: false };
            }
            const keptMode = confirmed.currentModeId === modeId;
            const nextTrack = playlist.tracks?.[0];
            const canAdvance = !!(keptMode && !playlist.error && nextTrack?.audioURL && nextTrack?.trackToken);
            stationModes = {
                ...confirmed, status: 'ready',
                error: !keptMode ? 'Pandora did not keep that mode active. Choose another available mode.'
                    : playlist.error || (!canAdvance ? 'The mode changed, but a new song could not be loaded. Try Next again.' : null)
            };
            if (canAdvance) {
                if (isPaused && operation.pauseRevision === pauseRevision) {
                    // Changing modes requests playback, but resuming still needs
                    // Pandora's approval and must never silently take over a device.
                    const resumed = await api.playbackResumed(false);
                    if (!isCurrent()) return { success: false };
                    if (resumed.streamConflict) {
                        await showStreamConflict(stationId, operation.generation);
                        return { success: false };
                    }
                    if (!resumed.success) {
                        stationModes.error = resumed.error || 'The mode changed, but playback could not resume. Please try Play again.';
                        return { success: false, error: stationModes.error };
                    }
                    // A pause pressed after choosing the mode still wins, even
                    // when Pandora acknowledges the resume request late.
                    if (operation.pauseRevision !== pauseRevision && isPaused) {
                        await api.playbackPaused(stationId, currentPlaylist[currentTrackIndex]?.trackToken);
                        if (!isCurrent()) return { success: false };
                    }
                }
                currentTrackIndex = currentPlaylist.length;
                currentPlaylist.push(...playlist.tracks);
                if (operation.pauseRevision === pauseRevision) isPaused = false;
                // A Next waiting on this operation must not skip this fresh song too.
                rememberTrack(nextTrack);
                api.trackStarted(stationId, nextTrack.trackToken);
            }
            return { success: canAdvance, error: stationModes.error };
        } catch {
            if (isCurrent()) stationModes = { ...emptyStationModes(), status: 'error', error: 'Could not confirm the station mode. Please try again.' };
            return { success: false };
        } finally {
            if (stationModeChange === operation) {
                stationModeChange = null;
                sendPlayerState(getCurrentState());
            }
        }
    })();
    return operation.promise;
}

async function replayTrack() {
    // Just send current state - UI will reset audio position
    sendPlayerState(getCurrentState());
    return getCurrentState();
}

async function setTrackFeedback(isPositive) {
    const track = currentPlaylist[currentTrackIndex];
    if (!track?.trackToken) return { success: false, error: 'No track selected.' };
    const rating = isPositive ? 1 : -1;
    if (feedbackForTrack(track) === (isPositive ? 'thumbUp' : 'thumbDown')) return { success: true };
    const result = await api.addFeedback(track.trackToken, isPositive);
    if (!result.success) {
        sendPlayerState(getCurrentState());
        return { success: false, error: 'Could not save your thumb. Please try again.' };
    }
    track.rating = rating;
    track.songRating = rating;
    track.feedbackId = result.feedbackId || null;
    const histItem = songHistory.find(h => h.trackToken === track.trackToken);
    if (histItem) {
        histItem.feedback = isPositive ? 'liked' : 'disliked';
        histItem.feedbackId = track.feedbackId;
    }
    // A delayed thumbs-down must never skip a different song after a mode change.
    if (!isPositive && currentPlaylist[currentTrackIndex] === track) {
        await skipTrack();
    } else sendPlayerState(getCurrentState());
    return { success: true };
}

async function thumbUp() { return setTrackFeedback(true); }
async function thumbDown() { return setTrackFeedback(false); }

// ============================================================================
// IPC Handlers
// ============================================================================

// Initialize app
ipcMain.handle('APP:INIT', async () => {
    try {
        // Always do a fresh login with saved credentials on startup.
        // Auth tokens expire between sessions, so restoring a stale token
        // just causes 401s that trigger the relogin cascade anyway.
        const restoreResult = await restoreSavedSession();
        if (restoreResult.success) {
            return { status: 'authenticated' };
        }

        // If restoreSavedSession failed (no credentials or login rejected),
        // show the login screen. Don't wipe credentials — the user can retry.
        sendLoginStatus(false);
        if (restoreResult.error) {
            sendToUI('UI:ERROR', { message: restoreResult.error });
        }
        return { status: 'needsLogin' };
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
    playbackGeneration++;
    stationLoading = false;
    resetStationModes();
    try {
        // Tell Pandora to stop the stream for this session so it doesn't hang
        const track = currentPlaylist[currentTrackIndex];
        if (!streamReclaimed && currentStation && track && track.trackToken) {
            await api.playbackPaused(currentStation.stationId, track.trackToken);
        }

        api.logout();
    } catch (err) {
        console.error('[Main] AUTH:LOGOUT error:', err);
    }

    // Clear playback state
    currentPlaylist = [];
    currentStation = null;
    streamReclaimed = false;
    isPaused = true;
    songHistory = [];
    currentTrackIndex = -1;
    sendPlayerState(getCurrentState());

    sendLoginStatus(false);
    return { success: true };
});

// Player commands
ipcMain.handle('PLAYER:GET_STATION_MODES', (event, { stationId } = {}) => loadStationModes(stationId));
ipcMain.handle('PLAYER:SET_STATION_MODE', (event, { stationId, modeId } = {}) => changeStationMode(stationId, modeId));

ipcMain.handle('PLAYER:CMD', async (event, { action, value }) => {
    switch (action) {
        case 'next':
            return await skipTrack();
        case 'prev':
            return await replayTrack();
        case 'thumbUp':
            return await thumbUp();
        case 'thumbDown':
            return await thumbDown();
        case 'toggle':
            return isPaused || streamReclaimed ? await resumePlayer() : await pausePlayer();
        case 'play':
            return await resumePlayer();
        case 'pause':
            return await pausePlayer();
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
    const track = currentPlaylist.find(t => t.trackToken === trackToken);
    const feedbackId = track?.feedbackId || histItem?.feedbackId;
    if (!feedbackId) {
        return { success: false, error: 'This saved thumb could not be removed here. You can change it in Pandora.' };
    }
    const result = await api.deleteFeedback(feedbackId);
    if (result.success) {
        if (track) { track.rating = 0; track.songRating = 0; track.feedbackId = null; }
        if (histItem) { histItem.feedback = null; histItem.feedbackId = null; }
        sendPlayerState(getCurrentState());
    }
    return result.success ? result : { success: false, error: 'Could not remove your thumb. Please try again.' };
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

ipcMain.handle('CONTENT:PLAY_SHUFFLE', async () => {
    sendToUI('UI:LOADING', { isLoading: true });
    try {
        const shuffleStation = await api.getShuffleStation();
        if (shuffleStation && shuffleStation.stationId) {
            // This endpoint identifies Shuffle even when its response omits flags.
            shuffleStation.isShuffle = true;
            // Update lastUpdated so it appears immediately in "Jump Back In"
            shuffleStation.lastUpdated = new Date().toISOString();

            // Ensure the shuffle station is in our currentStations list so UI stays synced
            const existingIdx = currentStations.findIndex(s => s.stationId === shuffleStation.stationId);
            if (existingIdx === -1) {
                currentStations.unshift(shuffleStation);
            } else {
                currentStations[existingIdx] = { ...currentStations[existingIdx], ...shuffleStation };
            }
            sendStations(currentStations);
            const result = await playStation(shuffleStation.stationId);
            sendToUI('UI:LOADING', { isLoading: false });
            return result;
        }
        sendToUI('UI:LOADING', { isLoading: false });
        return { error: 'Failed to fetch shuffle station.' };
    } catch (e) {
        console.error('[Main] Play shuffle error:', e);
        sendToUI('UI:LOADING', { isLoading: false });
        return { error: e.message || 'Error fetching shuffle station' };
    }
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
    if (!currentStation || streamReclaimed || stationLoading ||
        stationModeChange?.generation === playbackGeneration) return { tracks: [] };
    const generation = playbackGeneration;
    const stationId = currentStation.stationId;
    const result = await api.getPlaylist(stationId);
    if (generation !== playbackGeneration) return { tracks: [] };
    if (result.streamConflict) {
        await showStreamConflict(stationId, generation);
        return { tracks: [] };
    }
    const moreTracks = result.tracks || [];
    currentPlaylist.push(...moreTracks);
    if (result.error) sendToUI('UI:ERROR', { message: result.error });
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
    api.onVerificationRequired = (challenge, blockedUrl) => {
        if (!uiWindow || uiWindow.isDestroyed()) return false;
        console.log('[Main] Pandora requires human verification. Opening challenge...');
        return verification.show(challenge, blockedUrl, { parent: uiWindow, userAgent: api.getUserAgent() });
    };

    // Handle session expiration
    let isRelogging = false;
    api.onSessionExpired = async () => {
        if (isRelogging) return false;
        isRelogging = true;

        try {
            console.log('[Main] Session expired. Attempting auto-relogin...');
            try {
                // Re-authenticate without triggering a full UI re-render.
                // login() calls sendLoginStatus(true) which flashes the UI and
                // wipes the player state. Instead, just re-auth silently.
                const creds = config.getCredentials();
                if (!creds?.email || !creds?.password) {
                    throw new Error('No saved credentials');
                }
                console.log('[Main] Attempting sign-in with saved credentials...');
                const result = await api.login(creds.email, creds.password);
                if (result.success) {
                    console.log('[Main] Auto-relogin successful.');

                    // Refresh the playlist so audio URLs aren't expired
                    if (currentStation && !streamReclaimed && !stationLoading && !stationModeChange) {
                        const generation = playbackGeneration;
                        const stationId = currentStation.stationId;
                        console.log('[Main] Refreshing playlist for current station...');
                        const playlistResult = await api.getPlaylist(stationId);
                        if (generation === playbackGeneration && !streamReclaimed && playlistResult.streamConflict) {
                            await showStreamConflict(stationId, generation);
                        } else if (generation === playbackGeneration && !streamReclaimed && playlistResult.tracks?.length > 0) {
                            // Replace remaining tracks with fresh ones
                            currentPlaylist = currentPlaylist.slice(0, currentTrackIndex).concat(playlistResult.tracks);
                            // Stay on the first fresh track
                            currentTrackIndex = Math.min(currentTrackIndex, currentPlaylist.length - 1);
                            rememberTrack(currentPlaylist[currentTrackIndex]);
                            sendPlayerState(getCurrentState());
                        }
                    }

                    return true; // Relogin successful, return true for retry
                }
                sendToUI('UI:ERROR', { message: result.error });
            } catch (err) {
                console.error('[Main] Auto-relogin failed:', err);
            }

            // Relogin failed — clear tokens but KEEP saved credentials so the
            // next app launch (or manual login) can still use them.
            console.log('[Main] Auto-relogin failed. Clearing session tokens.');
            config.clearTokens();
            api.authToken = null;
            sendLoginStatus(false);
            return false;
        } finally {
            isRelogging = false;
        }
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

app.on('before-quit', () => verification.cancel());

// Handle certificate errors for development only
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    // Verification always requires a trusted Pandora connection, including dev.
    if (verification.ownsWebContents(webContents)) {
        callback(false);
        return;
    }
    if (!app.isPackaged) {
        event.preventDefault();
        callback(true);
    } else {
        callback(false);
    }
});
