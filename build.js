const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, 'dist');

// All source files to copy into dist
const filesToCopy = [
    'main.js',
    'pandora-api.js',
    'config.js',
    'preload-ui.js',
    'renderer.js',
    'visualizer.js',
    'components.js',
    'package.json',
    'index.html',
    'styles.css',
    'screenshot.png',
    'assets/icon.ico',
    'assets/icon.icns',
    'assets/icon.png'
];

// Clean and create dist
if (fs.existsSync(DIST)) {
    fs.rmSync(DIST, { recursive: true });
}
fs.mkdirSync(DIST, { recursive: true });
fs.mkdirSync(path.join(DIST, 'assets'), { recursive: true });

// Copy all files
for (const file of filesToCopy) {
    const src = path.join(__dirname, file);
    if (!fs.existsSync(src)) {
        console.log(`  SKIP ${file} (not found)`);
        continue;
    }
    const dest = path.join(DIST, file);
    fs.copyFileSync(src, dest);
    console.log(`  COPIED ${file}`);
}

// Copy package-lock.json if it exists
const lockFile = path.join(__dirname, 'package-lock.json');
if (fs.existsSync(lockFile)) {
    fs.copyFileSync(lockFile, path.join(DIST, 'package-lock.json'));
    console.log('  COPIED package-lock.json');
}

console.log('\nStage complete! Output in ./dist/');
