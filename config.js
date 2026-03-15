/**
 * Panedora - Configuration Storage
 * Simple file-based storage (no external dependencies)
 */

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

// Storage file path
const getConfigPath = () => {
    const userDataPath = app.getPath('userData');
    return path.join(userDataPath, 'panedora-config.json');
};

// Default config
const defaultConfig = {
    credentials: null,
    authToken: null,
    csrfToken: null,
    listenerId: null
};

// Read config from file
function readConfig() {
    try {
        const configPath = getConfigPath();
        if (fs.existsSync(configPath)) {
            const data = fs.readFileSync(configPath, 'utf8');
            return { ...defaultConfig, ...JSON.parse(data) };
        }
    } catch (e) {
        console.error('[Config] Error reading config:', e);
    }
    return { ...defaultConfig };
}

// Write config to file
function writeConfig(config) {
    try {
        const configPath = getConfigPath();
        // Ensure the userData directory exists (may not on first launch on macOS/Linux)
        const dir = path.dirname(configPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch (e) {
        console.error('[Config] Error writing config:', e);
    }
}

// In-memory cache
let configCache = null;

function getConfig() {
    if (!configCache) {
        configCache = readConfig();
    }
    return configCache;
}

function setConfig(key, value) {
    const config = getConfig();
    config[key] = value;
    configCache = config;
    writeConfig(config);
}

// Encrypt a string using Electron's safeStorage (OS keychain)
function encryptString(str) {
    if (safeStorage.isEncryptionAvailable()) {
        try {
            return safeStorage.encryptString(str).toString('base64');
        } catch (e) {
            // safeStorage can throw on unsigned macOS apps even when
            // isEncryptionAvailable() returns true — fall through to plain text
            console.warn('[Config] safeStorage.encryptString failed, storing without encryption:', e.message);
        }
    }
    return str; // Fallback to plain text
}

// Decrypt a string using Electron's safeStorage
function decryptString(str) {
    if (safeStorage.isEncryptionAvailable()) {
        try {
            return safeStorage.decryptString(Buffer.from(str, 'base64'));
        } catch (e) {
            // May be plain text from before encryption was enabled
            return str;
        }
    }
    return str;
}

module.exports = {
    // Credentials (encrypted at rest)
    getCredentials: () => {
        const creds = getConfig().credentials;
        if (!creds) return null;

        if (creds.passwordEncrypted) {
            return { email: creds.email, password: decryptString(creds.passwordEncrypted) };
        }

        // Migrate old plain-text "password" field to encrypted format
        if (creds.password) {
            const plainPassword = creds.password;
            setConfig('credentials', {
                email: creds.email,
                passwordEncrypted: encryptString(plainPassword)
            });
            return { email: creds.email, password: plainPassword };
        }

        return { email: creds.email, password: '' };
    },
    setCredentials: (email, password) => {
        setConfig('credentials', {
            email,
            passwordEncrypted: encryptString(password)
        });
    },
    clearCredentials: () => setConfig('credentials', null),

    // Auth Token (from login response)
    getAuthToken: () => getConfig().authToken,
    setAuthToken: (token) => setConfig('authToken', token),
    clearAuthToken: () => setConfig('authToken', null),

    // CSRF Token (from cookies)
    getCsrfToken: () => getConfig().csrfToken,
    setCsrfToken: (token) => setConfig('csrfToken', token),

    // Listener ID (user ID)
    getListenerId: () => getConfig().listenerId,
    setListenerId: (id) => setConfig('listenerId', id),

    // Check if logged in
    isLoggedIn: () => {
        const token = getConfig().authToken;
        return token !== null && token !== undefined;
    },

    // Clear only session tokens (keep credentials for auto-relogin on next launch)
    clearTokens: () => {
        setConfig('authToken', null);
        setConfig('csrfToken', null);
    },

    // Clear all data (logout) — full wipe
    clearAll: () => {
        setConfig('credentials', null);
        setConfig('authToken', null);
        setConfig('csrfToken', null);
        setConfig('listenerId', null);
    }
};
