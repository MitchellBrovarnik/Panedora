const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const DIST = path.join(__dirname, 'dist');

// Files to obfuscate (your app code)
const jsFiles = [
    'src/main/main.js',
    'src/api/pandora-api.js',
    'src/utils/config.js',
    'src/main/preload-ui.js',
    'src/renderer/renderer.js',
    'src/ui/visualizer.js',
    'src/ui/components.js'
];

// Files to copy as-is (not JS, or shouldn't be obfuscated)
const copyFiles = [
    'package.json',
    'src/index.html',
    'src/styles.css',
    'screenshot.png',
    'assets/icon.ico',
    'assets/icon.icns',
    'assets/icon.png'
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

    const outPath = path.join(DIST, file);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, result.getObfuscatedCode());
    console.log(`  OBFUSCATED ${file}`);
}

// Copy non-JS files
for (const file of copyFiles) {
    const filePath = path.join(__dirname, file);
    if (!fs.existsSync(filePath)) {
        console.log(`  SKIP ${file} (not found)`);
        continue;
    }
    const outPath = path.join(DIST, file);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.copyFileSync(filePath, outPath);
    console.log(`  COPIED ${file}`);
}

// Copy package-lock.json if it exists
const lockFile = path.join(__dirname, 'package-lock.json');
if (fs.existsSync(lockFile)) {
    fs.copyFileSync(lockFile, path.join(DIST, 'package-lock.json'));
    console.log('  COPIED package-lock.json');
}

console.log('\nBuild complete! Output in ./dist/');
