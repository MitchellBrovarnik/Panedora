/**
 * Pandora Glass v2 - UI Preload Script
 * Context Bridge for API-based architecture
 */

const { contextBridge, ipcRenderer } = require('electron');

// ============================================================================
// Exposed API via Context Bridge
// ============================================================================

contextBridge.exposeInMainWorld('api', {
    // ========================================
    // App Lifecycle
    // ========================================
    init: () => ipcRenderer.invoke('APP:INIT'),

    // ========================================
    // Authentication
    // ========================================
    auth: {
        login: (username, password) => ipcRenderer.invoke('AUTH:LOGIN', { username, password }),
        logout: () => ipcRenderer.invoke('AUTH:LOGOUT')
    },

    // ========================================
    // Player Controls
    // ========================================
    player: {
        toggle: () => ipcRenderer.invoke('PLAYER:CMD', { action: 'toggle' }),
        play: () => ipcRenderer.invoke('PLAYER:CMD', { action: 'play' }),
        pause: () => ipcRenderer.invoke('PLAYER:CMD', { action: 'pause' }),
        next: () => ipcRenderer.invoke('PLAYER:CMD', { action: 'next' }),
        prev: () => ipcRenderer.invoke('PLAYER:CMD', { action: 'prev' }),
        seek: (seconds) => ipcRenderer.invoke('PLAYER:CMD', { action: 'seek', value: seconds }),
        setVolume: (value) => ipcRenderer.invoke('PLAYER:CMD', { action: 'volume', value }),
        shuffle: () => ipcRenderer.invoke('PLAYER:CMD', { action: 'shuffle' }),
        repeat: () => ipcRenderer.invoke('PLAYER:CMD', { action: 'repeat' }),
        thumbUp: () => ipcRenderer.invoke('PLAYER:CMD', { action: 'thumbUp' }),
        thumbDown: () => ipcRenderer.invoke('PLAYER:CMD', { action: 'thumbDown' }),
        tuneStation: (mode) => ipcRenderer.invoke('PLAYER:CMD', { action: 'tune', value: mode }),
        getMoreTracks: () => ipcRenderer.invoke('PLAYER:GET_MORE_TRACKS'),
        prepareStream: () => ipcRenderer.invoke('PLAYER:PREPARE_STREAM')
    },

    // ========================================
    // Content/Navigation
    // ========================================
    content: {
        getStations: () => ipcRenderer.invoke('CONTENT:REFRESH_STATIONS'),
        refreshStations: () => ipcRenderer.invoke('CONTENT:REFRESH_STATIONS'),
        playItem: (item) => ipcRenderer.invoke('NAV:PLAY_URI', { uri: `${item.type}:${item.id}`, ...item }),
        search: (query) => ipcRenderer.invoke('CONTENT:SEARCH', query),
        removeStation: (id) => ipcRenderer.invoke('CONTENT:REMOVE_STATION', id)
    },

    // ========================================
    // Event Listeners
    // ========================================
    onState: (callback) => {
        const handler = (event, state) => callback(state);
        ipcRenderer.on('UI:PLAYER_STATE', handler);
        return () => ipcRenderer.removeListener('UI:PLAYER_STATE', handler);
    },

    onCollection: (callback) => {
        const handler = (event, data) => callback(data);
        ipcRenderer.on('UI:COLLECTION_DATA', handler);
        return () => ipcRenderer.removeListener('UI:COLLECTION_DATA', handler);
    },

    onSearchResults: (callback) => {
        const handler = (event, data) => callback(data);
        ipcRenderer.on('UI:SEARCH_RESULTS', handler);
        return () => ipcRenderer.removeListener('UI:SEARCH_RESULTS', handler);
    },

    onLoading: (callback) => {
        const handler = (event, data) => callback(data);
        ipcRenderer.on('UI:LOADING', handler);
        return () => ipcRenderer.removeListener('UI:LOADING', handler);
    },

    onLoginStatus: (callback) => {
        const handler = (event, status) => callback(status);
        ipcRenderer.on('UI:LOGIN_STATUS', handler);
        return () => ipcRenderer.removeListener('UI:LOGIN_STATUS', handler);
    }
});
