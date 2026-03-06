const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, 'dist');

// All files to copy to dist
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
    'screenshot.png'
];

// Clean and create dist
if (fs.existsSync(DIST)) {
    fs.rmSync(DIST, { recursive: true });
}
fs.mkdirSync(DIST, { recursive: true });

// Copy all files to dist
for (const file of filesToCopy) {
    const filePath = path.join(__dirname, file);
    if (!fs.existsSync(filePath)) {
        console.log(`  SKIP ${file} (not found)`);
        continue;
    }
    fs.copyFileSync(filePath, path.join(DIST, file));
    console.log(`  COPIED ${file}`);
}

// Copy assets directory
const assetsDir = path.join(__dirname, 'assets');
const distAssetsDir = path.join(DIST, 'assets');
if (fs.existsSync(assetsDir)) {
    fs.mkdirSync(distAssetsDir, { recursive: true });
    const assetFiles = fs.readdirSync(assetsDir);
    for (const file of assetFiles) {
        fs.copyFileSync(
            path.join(assetsDir, file),
            path.join(distAssetsDir, file)
        );
        console.log(`  COPIED assets/${file}`);
    }
}

// Copy package-lock.json if it exists
const lockFile = path.join(__dirname, 'package-lock.json');
if (fs.existsSync(lockFile)) {
    fs.copyFileSync(lockFile, path.join(DIST, 'package-lock.json'));
    console.log('  COPIED package-lock.json');
}

console.log('\nBuild complete! Output in ./dist/');
