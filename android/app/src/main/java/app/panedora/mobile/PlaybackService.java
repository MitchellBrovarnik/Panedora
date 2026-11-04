package app.panedora.mobile;

import android.app.PendingIntent;
import android.content.Intent;
import android.net.Uri;
import androidx.annotation.NonNull;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.ForwardingPlayer;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

@UnstableApi
public final class PlaybackService extends MediaSessionService {
    private ExoPlayer player;
    private MediaSession session;
    private AppModel model;
    private final List<PandoraProtocol.Track> queue = new ArrayList<>();
    private final Set<String> seen = new HashSet<>();
    private int generation, resumeRevision;
    private boolean fetching, resuming, destroyed, wantPlayback;
    private String reportedToken = "";

    @Override public void onCreate() {
        super.onCreate(); model = AppModel.get(this); model.playback = this;
        player = new ExoPlayer.Builder(this).build();
        player.setAudioAttributes(new AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true);
        player.setHandleAudioBecomingNoisy(true); player.setWakeMode(C.WAKE_MODE_LOCAL);
        // Media buttons must follow the same takeover rules as the in-app Play button.
        Player controls = new ForwardingPlayer(player) {
            @Override public void play() { resume(false); }
            @Override public void setPlayWhenReady(boolean ready) { if (ready) resume(false); else pausePlayback(); }
            @Override public void pause() { pausePlayback(); }
        };
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        session = new MediaSession.Builder(this, controls).setSessionActivity(open).setCallback(new MediaSession.Callback() {
            @Override public MediaSession.ConnectionResult onConnect(@NonNull MediaSession session, @NonNull MediaSession.ControllerInfo controller) {
                if (!getPackageName().equals(controller.getPackageName()) && !controller.isTrusted()) return MediaSession.ConnectionResult.reject();
                return MediaSession.Callback.super.onConnect(session, controller);
            }
        }).build();
        player.addListener(new Player.Listener() {
            @Override public void onMediaItemTransition(MediaItem item, int reason) { currentChanged(); }
            @Override public void onIsPlayingChanged(boolean playing) {
                model.playing = playing;
                if (playing) reportStarted();
                model.changed();
            }
            @Override public void onPlaybackStateChanged(int state) {
                model.loading = state == Player.STATE_BUFFERING;
                if (state == Player.STATE_ENDED) refill();
                model.changed();
            }
            @Override public void onPlayerError(@NonNull PlaybackException error) {
                model.playing = false; model.loading = false;
                model.message = "Playback stopped. Check your connection, then tap Play to get a fresh stream.";
                model.changed();
            }
        });
        model.changed();
    }
    @Override public MediaSession onGetSession(@NonNull MediaSession.ControllerInfo controllerInfo) { return session; }

    void select(PandoraProtocol.Station station) { load(station, false); }
    private void load(PandoraProtocol.Station station, boolean takeOver) {
        int request = ++generation; ++resumeRevision;
        pausePlayback(); wantPlayback = true; queue.clear(); seen.clear(); player.clearMediaItems(); fetching = true;
        model.station = station; model.track = null; model.loading = true; model.message = ""; model.takeover = false; reportedToken = ""; model.changed();
        model.io.execute(() -> {
            try {
                model.api.resume(takeOver);
                List<PandoraProtocol.Track> tracks = model.api.playlist(station.id, true);
                if (tracks.isEmpty()) throw new Exception("Pandora did not return playable songs for this station. Try another station.");
                model.main.post(() -> {
                    if (!current(request)) return;
                    fetching = false; append(tracks); player.prepare(); if (wantPlayback) player.play(); model.loading = false; model.changed();
                });
            } catch (Exception e) { model.main.post(() -> { if (current(request)) { fetching = false; model.loading = false; model.fail(e, () -> select(station)); } }); }
        });
    }
    void resume(boolean takeOver) {
        if (destroyed || !model.signedIn || model.station == null || resuming) return;
        if (player.getMediaItemCount() == 0 || player.getPlayerError() != null) { load(model.station, takeOver); return; }
        int request = generation, revision = ++resumeRevision; resuming = true; wantPlayback = true; model.takeover = false; model.message = ""; model.changed();
        model.io.execute(() -> {
            try {
                model.api.resume(takeOver);
                model.main.post(() -> {
                    if (!current(request) || revision != resumeRevision) return;
                    resuming = false; reportedToken = "";
                    if (player.getPlaybackState() == Player.STATE_ENDED) refill(); else player.play();
                });
            } catch (Exception e) { model.main.post(() -> { if (current(request) && revision == resumeRevision) { resuming = false; model.fail(e, () -> resume(false)); } }); }
        });
    }
    void pausePlayback() {
        ++resumeRevision; resuming = false; wantPlayback = false;
        boolean wasPlaying = player.getPlayWhenReady();
        PandoraProtocol.Station station = model.station; PandoraProtocol.Track track = model.track;
        player.pause();
        if (wasPlaying && station != null && track != null) model.io.execute(() -> { try { model.api.paused(station.id, track.token); } catch (Exception ignored) { /* Local pause must always work. */ } });
    }
    void toggle() { if (player.getPlayWhenReady() || resuming) pausePlayback(); else resume(false); }
    void next() {
        if (model.takeover || fetching && queue.isEmpty()) return;
        if (player.hasNextMediaItem()) player.seekToNextMediaItem(); else refill();
    }
    void seek(long position) { player.seekTo(Math.max(0, position)); }
    long position() { return player.getCurrentPosition(); }
    long duration() { return player.getDuration() == C.TIME_UNSET ? (model.track == null ? 0 : model.track.seconds * 1000L) : player.getDuration(); }
    boolean readyToPlay() { return player.getPlayWhenReady(); }
    private boolean current(int request) { return !destroyed && request == generation && model.signedIn; }
    private void append(List<PandoraProtocol.Track> tracks) {
        List<MediaItem> items = new ArrayList<>();
        for (PandoraProtocol.Track track : tracks) {
            if (!seen.add(track.token)) continue;
            queue.add(track);
            MediaMetadata.Builder metadata = new MediaMetadata.Builder().setTitle(track.title).setArtist(track.artist).setAlbumTitle(track.album);
            if (!track.art.isEmpty()) metadata.setArtworkUri(Uri.parse(track.art));
            items.add(new MediaItem.Builder().setMediaId(track.token).setUri(track.audio).setMediaMetadata(metadata.build()).build());
        }
        player.addMediaItems(items);
    }
    private void currentChanged() {
        int index = player.getCurrentMediaItemIndex();
        if (index < 0 || index >= queue.size()) return;
        PandoraProtocol.Track next = queue.get(index);
        if (model.track != null && model.track != next) {
            model.history.add(0, model.track);
            if (model.history.size() > 20) model.history.remove(20);
        }
        model.track = next; reportedToken = ""; model.changed();
        if (player.isPlaying()) reportStarted();
        if (queue.size() - index <= 2) refill();
    }
    private void reportStarted() {
        if (model.track == null || model.station == null || model.track.token.equals(reportedToken)) return;
        reportedToken = model.track.token;
        String token = reportedToken, station = model.station.id; int request = generation;
        model.io.execute(() -> {
            try { model.api.started(station, token); }
            catch (Exception e) { model.main.post(() -> {
                if (!current(request)) return;
                if (e instanceof PandoraClient.ApiException api && (api.conflict() || api.expired() || api.verification())) { pausePlayback(); model.fail(e, () -> resume(false)); }
            }); }
        });
    }
    private void refill() {
        if (fetching || model.station == null || !model.signedIn || model.takeover || destroyed) return;
        fetching = true; int request = generation; String station = model.station.id;
        model.io.execute(() -> {
            try {
                List<PandoraProtocol.Track> tracks = model.api.playlist(station, false);
                model.main.post(() -> {
                    if (!current(request)) return;
                    fetching = false; int count = queue.size(); boolean ended = player.getPlaybackState() == Player.STATE_ENDED;
                    append(tracks);
                    if (queue.size() == count) { model.message = "No more songs were returned. Tap Play or choose a station to retry."; model.changed(); return; }
                    if (ended) { player.seekTo(count, 0); player.prepare(); if (wantPlayback) player.play(); }
                });
            } catch (Exception e) { model.main.post(() -> {
                if (!current(request)) return;
                fetching = false;
                if (e instanceof PandoraClient.ApiException api && (api.conflict() || api.expired() || api.verification())) pausePlayback();
                model.fail(e, this::refill);
            }); }
        });
    }
    void clearPlayback() {
        ++generation; pausePlayback(); fetching = false; queue.clear(); seen.clear(); player.stop(); player.clearMediaItems();
        model.track = null; model.station = null; model.playing = false; model.loading = false;
    }
    @Override public void onDestroy() {
        destroyed = true; ++generation; ++resumeRevision;
        if (session != null) session.release();
        if (player != null) player.release();
        if (model != null) { model.playback = null; model.playing = model.loading = false; model.changed(); }
        super.onDestroy();
    }
}
