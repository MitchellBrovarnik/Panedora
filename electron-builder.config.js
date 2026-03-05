module.exports = {
    appId: 'com.panedora.app',
    productName: 'Panedora',
    directories: {
        app: 'dist',
        output: 'release'
    },
    files: ['**/*'],
    win: {
        target: 'nsis',
        icon: 'dist/icon.ico'
    },
    nsis: {
        oneClick: false,
        allowToChangeInstallationDirectory: true,
        installerHeaderIcon: 'dist/icon.ico'
    },
    mac: {
        target: 'dmg',
        icon: 'dist/icon.icns'
    },
    linux: {
        target: ['AppImage', 'deb'],
        icon: 'dist/icon.png',
        category: 'Audio'
    }
};
