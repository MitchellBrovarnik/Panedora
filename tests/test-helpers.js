const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadModule(filename, mocks) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports,
        require: name => Object.hasOwn(mocks, name) ? mocks[name] : require(name),
        __dirname: path.dirname(filename),
        URL, AbortController, setTimeout, clearTimeout,
        console: { log() {}, warn() {}, error() {} }
    }, { filename });
    return module.exports;
}

const challenge = {
    status: 403,
    message: 'Invalid request',
    errorCode: 1215,
    errorString: 's2s_high_score',
    appId: 'PXXljWHHUe',
    jsClientSrc: '/XljWHHUe/init.js',
    firstPartyEnabled: false,
    vid: null,
    uuid: '11111111-2222-3333-4444-555555555555',
    hostUrl: '/XljWHHUe/xhr',
    blockScript: '/XljWHHUe/captcha?a=c&u=11111111-2222-3333-4444-555555555555'
};

module.exports = { loadModule, challenge };
