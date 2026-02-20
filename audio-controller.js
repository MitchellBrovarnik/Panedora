// Audio Controller - Injected into hidden Pandora window
// Uses postMessage since executeJavaScript doesn't have access to require()

console.log('[AudioController] Injected into Pandora');

// Scrape playback state and post to window
function scrapeAndPost() {
    try {
        const trackName = document.querySelector('[data-qa="mini_track_title"]')?.innerText ||
            document.querySelector('.Tuner__Audio__TrackDetail__title')?.innerText ||
            document.querySelector('.NowPlayingTopInfo__current__trackName')?.innerText;

        const artistName = document.querySelector('[data-qa="mini_track_artist_name"]')?.innerText ||
            document.querySelector('.Tuner__Audio__TrackDetail__artist')?.innerText ||
            document.querySelector('.NowPlayingTopInfo__current__artistName')?.innerText;

        const artSrc = document.querySelector('.Tuner__Audio__TrackDetail__img img')?.src ||
            document.querySelector('[data-qa="mini_track_image"]')?.src ||
            document.querySelector('.NowPlayingTopInfo__albumArt img')?.src;

        // Time elements
        const timeEl = document.querySelector('[data-qa="elapsed_time"]');
        const remainingEl = document.querySelector('[data-qa="remaining_time"]');

        const parseTime = (str) => {
            if (!str) return 0;
            const parts = str.replace('-', '').split(':');
            if (parts.length === 2) return parseInt(parts[0]) * 60 + parseInt(parts[1]);
            return 0;
        };

        const currentTime = parseTime(timeEl?.innerText);
        const remainingTime = parseTime(remainingEl?.innerText);
        const duration = currentTime + remainingTime;

        // Playing state - pause button visible means playing
        const isPlaying = !!document.querySelector('[data-qa="pause_button"]');

        if (trackName) {
            // Post state back via custom event that main.js can listen to
            console.log('[AudioController] Track:', trackName, 'Artist:', artistName);

            // Store state globally for main process to query
            window.__pandoraState = {
                track: trackName,
                artist: artistName || '',
                coverArt: artSrc || '',
                time: currentTime,
                duration: duration || 1,
                isPlaying: isPlaying
            };
        }
    } catch (e) {
        console.error('[AudioController] Scrape error:', e);
    }
}

// Run scraper every second
setInterval(scrapeAndPost, 1000);

// Initial scrape
setTimeout(scrapeAndPost, 2000);

// Auto-click "Still Listening?" prompts
const observer = new MutationObserver(() => {
    const stillListeningBtn = document.querySelector('.StillListeningBody__button');
    if (stillListeningBtn) {
        console.log('[AudioController] Clicking Still Listening');
        stillListeningBtn.click();
    }
});
observer.observe(document.body, { childList: true, subtree: true });

console.log('[AudioController] Setup complete');
