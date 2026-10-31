// Download links fall back to the release page when GitHub is unavailable.
document.addEventListener('DOMContentLoaded', () => {
    // Fetch latest release and update download links
    const releasePage = 'https://github.com/MitchellBrovarnik/Panedora/releases/latest';
    const isDownload = asset => typeof asset?.browser_download_url === 'string' &&
        asset.browser_download_url.startsWith('https://github.com/MitchellBrovarnik/Panedora/releases/download/');
    fetch('https://api.github.com/repos/MitchellBrovarnik/Panedora/releases/latest', { credentials: 'omit', referrerPolicy: 'no-referrer' })
        .then(res => {
            if (!res.ok) throw new Error('Release check unavailable');
            return res.json();
        })
        .then(release => {
            if (release.draft !== false || release.prerelease !== false) return;
            const assets = Array.isArray(release.assets) ? release.assets.filter(a => typeof a?.name === 'string' && isDownload(a)) : [];
            const winAsset = assets.find(a => a.name.endsWith('.exe'));
            const macAssets = assets.filter(a => a.name.endsWith('.dmg'));
            const linuxAsset = assets.find(a => a.name.endsWith('.AppImage'));

            if (winAsset) document.getElementById('download-win').href = winAsset.browser_download_url;
            const mac = document.getElementById('download-mac');
            if (macAssets.length === 1) {
                mac.href = macAssets[0].browser_download_url;
                const architecture = /arm64/i.test(macAssets[0].name) ? 'Apple Silicon'
                    : /(?:x64|amd64)/i.test(macAssets[0].name) ? 'Intel' : '';
                mac.querySelector('.download-btn').textContent = 'Download .dmg' + (architecture ? ' · ' + architecture : '');
                if (architecture) mac.setAttribute('aria-label', 'Download Panedora for macOS (' + architecture + ')');
            } else if (macAssets.length > 1) {
                mac.href = releasePage;
                mac.querySelector('.download-btn').textContent = 'Choose a macOS build';
            }
            if (linuxAsset) document.getElementById('download-linux').href = linuxAsset.browser_download_url;
            if (typeof release.tag_name === 'string' && /^v?\d+\.\d+\.\d+$/i.test(release.tag_name)) {
                document.getElementById('latest-release-label').textContent = 'Latest release: ' + release.tag_name;
            }
        })
        .catch(() => {});
});
