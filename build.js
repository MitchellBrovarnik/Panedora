const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const DIST = path.join(__dirname, 'dist');

// Files to obfuscate (your app code)
const jsFiles = [
    'main.js',
    'pandora-api.js',
    'config.js',
    'preload-ui.js',
    'renderer.js',
    'visualizer.js',
    'components.js'
];

// Files to copy as-is (not JS, or shouldn't be obfuscated)
const copyFiles = [
    'package.json',
    'index.html',
    'styles.css',
    'screenshot.png',
    'icon.ico',
    'icon.icns',
    'icon.png'
];

// Light obfuscation — renames variables/functions, zero performance cost
const obfuscationOptions = {
    compact: true,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    stringArray: false,
    renameGlobals: false,
    identifierNamesGenerator: 'mangled'
};

// Clean and create dist
if (fs.existsSync(DIST)) {
    fs.rmSync(DIST, { recursive: true });
}
fs.mkdirSync(DIST, { recursive: true });

// Obfuscate JS files
for (const file of jsFiles) {
    const filePath = path.join(__dirname, file);
    if (!fs.existsSync(filePath)) {
        console.log(`  SKIP ${file} (not found)`);
        continue;
    }
    const code = fs.readFileSync(filePath, 'utf8');
    const result = JavaScriptObfuscator.obfuscate(code, obfuscationOptions);
    fs.writeFileSync(path.join(DIST, file), result.getObfuscatedCode());
    console.log(`  OBFUSCATED ${file}`);
}

// Copy non-JS files
for (const file of copyFiles) {
    const filePath = path.join(__dirname, file);
    if (!fs.existsSync(filePath)) {
        console.log(`  SKIP ${file} (not found)`);
        continue;
    }
    fs.copyFileSync(filePath, path.join(DIST, file));
    console.log(`  COPIED ${file}`);
}

// Copy package-lock.json if it exists
const lockFile = path.join(__dirname, 'package-lock.json');
if (fs.existsSync(lockFile)) {
    fs.copyFileSync(lockFile, path.join(DIST, 'package-lock.json'));
    console.log('  COPIED package-lock.json');
}

console.log('\nBuild complete! Output in ./dist/');
