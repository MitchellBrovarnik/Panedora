/**
 * Pandora Glass - Main Process
 * The Application Core: Orchestrates worker and UI windows via IPC
 */

const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');

let workerWindow = null;
let uiWindow = null;

// ============================================================================
// Window Creation
// ============================================================================

function createWorkerWindow() {
    workerWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        show: false, // Hidden - acts as headless API server
        webPreferences: {
            preload: path.join(__dirname, 'preload-worker.js'),
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
            partition: 'persist:pandora'
        }
    });

    workerWindow.loadURL('https://www.pandora.com');

    workerWindow.webContents.on('did-finish-load', () => {
        console.log('[Worker] Pandora loaded successfully');
    });

    workerWindow.webContents.on('did-fail-load', (event, errorCode, errorDesc) => {
        console.error('[Worker] Failed to load Pandora:', errorDesc);
    });

    // For debugging - open DevTools on worker
    if (process.argv.includes('--dev')) {
        workerWindow.show();
        workerWindow.webContents.openDevTools();
    }
}

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
        if (workerWindow) {
            workerWindow.close();
        }
    });
}

// ============================================================================
// IPC Orchestration
// ============================================================================

// APP:INIT - UI requests initial data load
ipcMain.handle('APP:INIT', async () => {
    console.log('[IPC] APP:INIT - Initializing application');
    if (workerWindow) {
        workerWindow.webContents.send('WORKER:GET_COLLECTION');
    }
    return { status: 'initializing' };
});

// PLAYER:CMD - Handle all player commands
ipcMain.handle('PLAYER:CMD', async (event, { action, value }) => {
    console.log(`[IPC] PLAYER:CMD - Action: ${action}, Value: ${value}`);
    if (workerWindow) {
        workerWindow.webContents.send('WORKER:PLAYER_CMD', { action, value });
    }
    return { status: 'ok', action };
});

// NAV:SEARCH - Search query from UI
ipcMain.handle('NAV:SEARCH', async (event, query) => {
    console.log(`[IPC] NAV:SEARCH - Query: ${query}`);
    if (workerWindow) {
        workerWindow.webContents.send('WORKER:SEARCH', query);
    }
    return { status: 'searching', query };
});

// NAV:PLAY_URI - Play a specific item by URI (song:123, station:456)
ipcMain.handle('NAV:PLAY_URI', async (event, uri) => {
    console.log(`[IPC] NAV:PLAY_URI - URI: ${uri}`);
    if (workerWindow) {
        workerWindow.webContents.send('WORKER:PLAY_URI', uri);
    }
    return { status: 'playing', uri };
});

// Forward collection data from worker to UI
ipcMain.on('WORKER:COLLECTION_DATA', (event, data) => {
    console.log('[IPC] Forwarding collection data to UI:', {
        count: data?.length || 0,
        stations: data?.slice(0, 3)?.map(s => s.name) || []
    });
    if (uiWindow) {
        uiWindow.webContents.send('UI:COLLECTION_DATA', data);
    }
});

// Forward search results from worker to UI
ipcMain.on('WORKER:SEARCH_RESULTS', (event, data) => {
    console.log('[IPC] Forwarding search results to UI');
    if (uiWindow) {
        uiWindow.webContents.send('UI:SEARCH_RESULTS', data);
    }
});

// Forward player state from worker to UI
ipcMain.on('WORKER:PLAYER_STATE', (event, state) => {
    if (uiWindow) {
        uiWindow.webContents.send('UI:PLAYER_STATE', state);
    }
});

// Forward login status
ipcMain.on('WORKER:LOGIN_STATUS', (event, status) => {
    console.log('[IPC] Login status:', status);
    if (uiWindow) {
        uiWindow.webContents.send('UI:LOGIN_STATUS', status);
    }
});

// ============================================================================
// App Lifecycle
// ============================================================================

app.whenReady().then(() => {
    // Set up session for persistent login
    const ses = session.fromPartition('persist:pandora');

    createWorkerWindow();
    createUIWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWorkerWindow();
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
