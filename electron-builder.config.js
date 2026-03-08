module.exports = {
    appId: 'com.panedora.app',
    productName: 'Panedora',
    directories: {
        app: 'dist',
        output: 'release'
    },
    publish: {
        provider: 'github',
        releaseType: 'release'
    },
    files: ['**/*'],
    win: {
        target: 'nsis',
        icon: 'dist/assets/icon.ico'
    },
    nsis: {
        oneClick: false,
        allowToChangeInstallationDirectory: true,
        installerHeaderIcon: 'dist/assets/icon.ico'
    },
    mac: {
        target: 'dmg',
        icon: 'dist/assets/icon.icns',
        identity: null,
        hardenedRuntime: false,
        gatekeeperAssess: false
    },
    dmg: {
        writeUpdateInfo: false
    },
    linux: {
        target: ['AppImage', 'deb'],
        icon: 'dist/assets/icon.png',
        category: 'Audio'
    }
};
