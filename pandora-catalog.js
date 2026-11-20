/* Pandora's authenticated web catalog and Premium playback source. */
const TRACK = /^TR:\d+$/;
const ALBUM = /^AL:\d+$/;
const ARTIST = /^AR:\d+$/;

function catalogRows(ids, annotations) {
    const results = { songs: [], albums: [], artists: [], stations: [], onDemand: true };
    for (const entry of ids || []) {
        const id = typeof entry === 'string' ? entry : entry?.pandoraId;
        const item = annotations?.[id] || entry;
        if (!id || !item?.name) continue;
        const common = { id, name: item.name, image: item.icon?.artUrl || null, artist: item.artistName || '' };
        if (TRACK.test(id)) results.songs.push({ ...common, type: 'song', title: item.name, duration: item.duration });
        else if (ALBUM.test(id)) results.albums.push({ ...common, type: 'album' });
        else if (ARTIST.test(id)) results.artists.push({ ...common, type: 'artist' });
        else if (/^(ST|SF):/.test(id)) results.stations.push({ ...common, type: 'station', stationId: item.stationId });
    }
    return results;
}

function playbackError(err) {
    if (err?.cancelled) return err;
    if (['SimStreamViolation', 'SimStreamViolationItem'].includes(err?.item?.type) || /STREAM_VIOLATION|SIMULTANEOUS/.test(err?.errorString || '')) {
        return new Error('Pandora is playing on another device. Pause it there and try this selection again.');
    }
    if (err?.errorString === 'NO_ENTITLEMENTS' || err?.status === 403) {
        return new Error('Pandora did not grant on-demand playback for this selection on your account.');
    }
    return new Error('Pandora could not load this selection. Please try again.');
}

function readTrack(reply, selection, position) {
    const item = reply?.item;
    if (['SimStreamViolation', 'SimStreamViolationItem'].includes(item?.type)) throw playbackError(reply);
    const id = selection.ids[position];
    if (item?.type !== 'Track' || item.pandoraId !== id ||
        [item.sourceId, reply?.source?.pandoraId].some(source => source && source !== selection.albumId) ||
        item.playerStyle === 'NON_INTERACTIVE') {
        throw new Error('Pandora did not return the requested recording. Choose another track or try again.');
    }
    let url;
    try { url = new URL(item.audioUrl); } catch { /* Missing or invalid stream. */ }
    if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
        !item.trackToken || !Number.isInteger(item.index) || item.index < 0) {
        throw new Error('Pandora did not provide playable audio for this recording.');
    }
    url.protocol = 'https:';
    const metadata = reply.annotations?.[id] || {};
    const art = item.artUrl || metadata.icon?.artUrl;
    return { catalogId: id, sourceIndex: item.index, songTitle: item.songName || metadata.name,
        albumTitle: item.albumName || metadata.albumName, artistName: item.artistName || metadata.artistName,
        trackLength: item.duration || metadata.duration || 0, albumArt: art ? [{ url: art }] : [],
        trackToken: item.trackToken, audioURL: url.href, interactions: item.interactions || [] };
}

class PandoraCatalog {
    constructor(api, getDeviceId) {
        this.api = api;
        this.getDeviceId = getDeviceId;
        this.pending = Promise.resolve();
    }

    async request(path, data, isCurrent = () => true) {
        const beforeRequest = () => {
            if (!this.api.hasPremiumAccess()) throw new Error('On-demand playback requires Pandora Premium.');
        };
        beforeRequest();
        try {
            return await this.api.request(path, data, { isCurrent, beforeRequest });
        } catch (err) {
            if (err?.cancelled || !this.api.hasPremiumAccess()) throw err;
            throw playbackError(err);
        }
    }

    async search(query) {
        const reply = await this.request('/v3/sod/search', { query, types: ['TR', 'AL', 'AR', 'SF'], listener: null,
            start: 0, count: 50, annotate: true, annotationRecipe: 'CLASS_OF_2019', searchTime: null });
        return catalogRows(reply.results, reply.annotations);
    }

    async artist(id) {
        if (!ARTIST.test(id)) throw new Error('Select a Pandora artist.');
        const reply = await this.request('/v4/catalog/getDetailsWithCollaborations', { pandoraId: id, listener: null });
        const artist = reply.artistDetails || reply.composerDetails || {};
        const ids = [...(artist.topTracks || []), ...(artist.topAlbums || [])];
        const annotations = { ...reply.annotations };
        const missing = ids.filter(key => !annotations[key]);
        if (missing.length) Object.assign(annotations, await this.annotate(missing));
        return catalogRows(ids, annotations);
    }

    async annotate(ids, isCurrent) {
        const reply = await this.request('/v4/catalog/annotateObjects', { pandoraIds: ids, annotateAlbumTracks: false }, isCurrent);
        return reply.annotations || reply;
    }

    async selection(id, isCurrent) {
        if (!TRACK.test(id) && !ALBUM.test(id)) throw new Error('Select a song or album from Search.');
        const item = (await this.annotate([id], isCurrent))[id];
        if (!item || item.rightsInfo?.hasInteractive === false) {
            throw new Error('This selection is unavailable for on-demand playback.');
        }
        const albumId = TRACK.test(id) ? item.albumId : id;
        const ids = TRACK.test(id) ? [id] : item.tracks;
        if (!ALBUM.test(albumId) || !Array.isArray(ids) || !ids.length || !ids.every(key => TRACK.test(key))) {
            throw new Error('Pandora did not supply the track list for this selection.');
        }
        return { albumId, ids };
    }

    // Source changes and cursor events share a device. Preserve their order at
    // Pandora as well as in the UI when the listener makes another selection.
    playback(path, data, isCurrent) {
        const run = this.pending.then(() => this.request(path, { ...data, deviceUuid: this.getDeviceId() }, isCurrent));
        this.pending = run.catch(() => {});
        return run;
    }

    async start(selection, position, isCurrent) {
        const reply = await this.playback('/v1/playback/source', { sourceId: selection.albumId,
            itemId: selection.ids[position], includeItem: true, includeSource: true }, isCurrent);
        return readTrack(reply, selection, position);
    }

    async current(selection, position, isCurrent) {
        const reply = await this.playback('/v1/playback/current', { sourceId: selection.albumId,
            includeItem: true, includeSource: true }, isCurrent);
        return readTrack(reply, selection, position);
    }

    async event(selection, track, action, elapsed, isCurrent, nextPosition) {
        const data = { sourceId: selection.albumId, index: track.sourceIndex,
            elapsedTime: Number.isFinite(elapsed) ? Math.max(0, Math.floor(elapsed)) : 0 };
        const paths = { started: '/v1/event/started', progress: '/v1/event/progress', ended: '/v1/event/ended',
            pause: '/v1/action/pause', next: '/v1/action/skip', previous: '/v1/action/previous' };
        if (action === 'ended') data.reason = 'NORMAL';
        if (action === 'pause') Object.assign(data, { pandoraId: track.catalogId, sync: false });
        if (action === 'next') data.checkOnly = false;
        if (nextPosition !== undefined) Object.assign(data, { includeItem: true, includeSource: true });
        const reply = await this.playback(paths[action], data, isCurrent);
        if (['SimStreamViolation', 'SimStreamViolationItem'].includes(reply?.item?.type)) throw playbackError(reply);
        if (nextPosition === undefined) return;
        // An acknowledgement can be empty after Pandora has advanced its cursor.
        return reply?.item ? readTrack(reply, selection, nextPosition) : this.current(selection, nextPosition, isCurrent);
    }
}
module.exports = { PandoraCatalog };
