const https = require('https');

// List of Invidious instances (ranked by reliability/speed)
const INSTANCES = [
    'https://vid.puffyan.us',
    'https://inv.tux.pizza',
    'https://invidious.projectsegfau.lt',
    'https://invidious.drgns.space',
    'https://yt.artemislena.eu'
];

function makeRequest(url, timeout = 3000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`Status ${res.statusCode}`));
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Timeout'));
        });
    });
}

// Try instances sequentially until one works
async function tryInstances(path) {
    // Shuffle instances to load balance
    const shuffled = [...INSTANCES].sort(() => 0.5 - Math.random());

    for (const instance of shuffled) {
        try {
            console.log(`[MusicFallback] Trying ${instance}...`);
            const result = await makeRequest(`${instance}${path}`);
            return result;
        } catch (e) {
            console.log(`[MusicFallback] ${instance} failed: ${e.message}`);
            continue;
        }
    }
    throw new Error('All instances failed');
}

async function search(query) {
    const path = `/api/v1/search?q=${encodeURIComponent(query)}&type=video&sort_by=relevance`;
    try {
        const results = await tryInstances(path);
        if (results && results.length > 0) {
            return results[0]; // Return first result
        }
    } catch (error) {
        console.error('[MusicFallback] Search failed:', error.message);
    }
    return null;
}

async function getStreamUrl(videoId) {
    const path = `/api/v1/videos/${videoId}`;
    try {
        const details = await tryInstances(path);
        if (details && details.formatStreams) {
            // Find best audio stream (m4a or webm audio)
            const audioStreams = details.adaptiveFormats.filter(f => f.type && f.type.startsWith('audio'));

            if (audioStreams.length > 0) {
                // Sort by bitrate desc
                audioStreams.sort((a, b) => parseInt(b.bitrate) - parseInt(a.bitrate));
                return audioStreams[0].url;
            }
        }
    } catch (error) {
        console.error('[MusicFallback] GetStreamUrl failed:', error.message);
    }
    return null;
}

module.exports = {
    search,
    getStreamUrl
};
