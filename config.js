/**
 * Pandora Glass - Configuration Storage
 * Simple file-based storage (no external dependencies)
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Storage file path
const getConfigPath = () => {
    const userDataPath = app.getPath('userData');
    return path.join(userDataPath, 'pandora-glass-config.json');
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
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
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

module.exports = {
    // Credentials
    getCredentials: () => getConfig().credentials,
    setCredentials: (email, password) => setConfig('credentials', { email, password }),
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

    // Clear all auth data (logout)
    clearAll: () => {
        setConfig('authToken', null);
        setConfig('csrfToken', null);
        setConfig('listenerId', null);
        // Keep credentials for re-login convenience
    }
};
