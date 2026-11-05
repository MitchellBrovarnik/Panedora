package app.panedora.mobile;

import android.app.PendingIntent;
import android.content.Intent;
import android.net.Uri;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
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
    private volatile int generation;
    private int resumeRevision, modesRevision;
    private boolean fetching, resuming, wantPlayback, advanceAfterRefill;
    private volatile boolean destroyed;
    Artwork.Preloader artwork;
    private String reportedToken = "";

    @Override public void onCreate() {
        super.onCreate(); model = AppModel.get(this); model.playback = this; artwork = new Artwork.Preloader(this);
        player = new ExoPlayer.Builder(this).build();
        player.setAudioAttributes(new AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true);
        player.setHandleAudioBecomingNoisy(true); player.setWakeMode(C.WAKE_MODE_LOCAL);
        // Media buttons must follow the same takeover rules as the in-app Play button.
        Player controls = new ForwardingPlayer(player) {
            @Override public void play() { resume(false); }
            @Override public void setPlayWhenReady(boolean ready) { if (ready) resume(false); else pausePlayback(); }
            @Override public void pause() { pausePlayback(); }
        };
        PendingIntent open = PendingIntent.getActivity(this, 0, MainActivity.nowPlayingIntent(this), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
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
    void shuffle() { load(new PandoraProtocol.Station("","Shuffle Stations","",true),false); }
    private void load(PandoraProtocol.Station station, boolean takeOver) {
        int request = ++generation; ++resumeRevision;
        // Player callbacks can request a refill while the old timeline is removed.
        // Keep that work fenced off until the new station and queue are installed.
        fetching=true;
        pausePlayback(); resetModes(); advanceAfterRefill=false;
        wantPlayback = true; artwork.clear(); queue.clear(); seen.clear();
        // Reset the old audio pipeline before replacing its timeline and preparing a new station.
        player.stop(); player.clearMediaItems();
        model.rememberCurrent(); model.station = station; model.track = null; model.loading = true; model.message = ""; model.takeover = false; reportedToken = ""; model.changed();
        model.io.execute(() -> {
            try {
                PandoraProtocol.Station selected = station.shuffle ? model.api.shuffleStation() : station;
                if (destroyed || generation != request) return;
                model.api.resume(takeOver);
                if (destroyed || generation != request) return;
                List<PandoraProtocol.Track> tracks = model.api.playlist(selected.id, true);
                if (tracks.isEmpty()) throw new Exception("Pandora did not return playable songs for this station. Try another station.");
                model.main.post(() -> {
                    if (!current(request)) return;
                    model.station = selected; if (selected.shuffle) model.rememberShuffle(selected);
                    fetching = false; append(tracks); player.prepare(); if (wantPlayback) player.play(); model.loading = false; model.changed();
                    if (!wantPlayback && model.track!=null) reportPaused(selected.id,model.track.token);
                    if (takeOver) loadModes(true);
                });
            } catch (Exception e) { model.main.post(() -> { if (current(request)) { fetching = false; model.loading = false; model.fail(e, () -> load(station,takeOver)); } }); }
        });
    }
    void resume(boolean takeOver) {
        if (destroyed || !model.signedIn || model.station == null || resuming) return;
        // An explicit takeover starts a fresh, approved queue and invalidates all
        // errors/metadata requested before it, just as the desktop client does.
        if (takeOver) { if (model.takeover) load(model.station,true); return; }
        if (model.takeover) return;
        if (model.modeChanging) { wantPlayback=true; model.changed(); return; }
        if (player.getPlayWhenReady() && (player.getPlaybackState()==Player.STATE_READY || player.getPlaybackState()==Player.STATE_BUFFERING)) return;
        if (fetching && player.getMediaItemCount() == 0) { wantPlayback = true; model.changed(); return; }
        if (player.getMediaItemCount() == 0 || player.getPlayerError() != null || player.getPlaybackState()==Player.STATE_IDLE) { load(model.station, takeOver); return; }
        int request = generation, revision = ++resumeRevision; resuming = true; wantPlayback = true; model.takeover = false; model.message = ""; model.changed();
        model.io.execute(() -> {
            try {
                model.api.resume(takeOver);
                model.main.post(() -> {
                    if (!current(request) || revision != resumeRevision) return;
                    resuming = false; model.takeover=false; model.message="";
                    if (!model.modeError.isEmpty()) { resetModes(); loadModes(true); }
                    if (player.getPlaybackState() == Player.STATE_ENDED) refill(); else player.play();
                });
            } catch (Exception e) { model.main.post(() -> { if (current(request) && revision == resumeRevision) { pausePlayback(false); model.fail(e, () -> resume(false)); } }); }
        });
    }
    void pausePlayback() { pausePlayback(true); }
    private void pausePlayback(boolean notifyPandora) {
        boolean approvalPending=resuming || model.modeChanging && wantPlayback;
        ++resumeRevision; resuming = false; wantPlayback = false;
        boolean wasPlaying = player.getPlayWhenReady();
        PandoraProtocol.Station station = model.station; PandoraProtocol.Track track = model.track;
        player.pause();
        // Cancelling a pending resume may not emit an ExoPlayer state change.
        model.changed();
        // A Pause during an in-flight approval must also reach Pandora, after
        // that approval, even though audio has not started locally yet.
        if (notifyPandora && !model.takeover && (wasPlaying || approvalPending) && station != null && track != null) reportPaused(station.id,track.token);
    }
    private void reportPaused(String station,String token) {
        model.io.execute(() -> { try { model.api.paused(station,token); } catch (Exception ignored) { /* Local pause must always work. */ } });
    }
    void toggle() { if (wantsPlayback()) pausePlayback(); else resume(false); }
    void next() {
        if (model.takeover || model.modeChanging || fetching && queue.isEmpty()) return;
        if (player.hasNextMediaItem()) player.seekToNextMediaItem(); else { advanceAfterRefill=true; refill(); }
    }
    void seek(long position) { player.seekTo(Math.max(0, position)); }
    long position() { return player.getCurrentPosition(); }
    long duration() { return player.getDuration() == C.TIME_UNSET ? (model.track == null ? 0 : model.track.seconds * 1000L) : player.getDuration(); }
    boolean wantsPlayback() { return player.getPlayWhenReady() || resuming || ((fetching || model.modeChanging) && wantPlayback); }
    private boolean current(int request) { return !destroyed && request == generation && model.signedIn; }
    private void resetModes() {
        ++modesRevision; model.modes=null; model.modesLoading=model.modeChanging=false; model.modeError="";
    }
    void loadModes(boolean refresh) {
        if (destroyed || !model.signedIn || model.station==null || model.station.shuffle || model.track==null || model.modeChanging || model.modesLoading || model.takeover || (!refresh && model.modes!=null && model.modeError.isEmpty())) return;
        String station=model.station.id; int request=generation, revision=++modesRevision;
        model.modesLoading=true; model.modeError=""; model.changed();
        model.io.execute(() -> {
            try {
                if (!current(request)) return;
                PandoraProtocol.Modes modes=model.api.stationModes(station);
                model.main.post(() -> {
                    if (!current(request) || revision!=modesRevision) return;
                    model.modes=modes; model.modesLoading=false; model.changed();
                });
            } catch (Exception error) { model.main.post(() -> {
                if (!current(request) || revision!=modesRevision) return;
                model.modesLoading=false; model.modeError=error.getMessage()==null ? "Could not load station modes. Try Refresh." : error.getMessage();
                if (error instanceof PandoraClient.ApiException api && (api.conflict() || api.expired() || api.verification())) { pausePlayback(false); model.fail(error,() -> loadModes(true)); }
                else model.changed();
            }); }
        });
    }
    void changeMode(long modeId) {
        if (destroyed || !model.signedIn || model.station==null || model.station.shuffle || model.track==null || model.modes==null || !model.modes.available || model.modeChanging || model.takeover) return;
        PandoraProtocol.Mode choice=model.modes.find(modeId);
        if (choice==null || !choice.available || model.modes.active(modeId)) return;
        boolean needsResume=!player.getPlayWhenReady();
        int request=++generation; ++resumeRevision; ++modesRevision; resuming=false; fetching=false; advanceAfterRefill=false;
        int approvalRevision=resumeRevision;
        String station=model.station.id;
        model.modeChanging=true; model.modesLoading=false; model.modeError=""; model.message=""; wantPlayback=true;
        // Keep the current audio while confirming the change, but discard the old queued mix.
        int index=player.getCurrentMediaItemIndex();
        if (index>=0 && index+1<player.getMediaItemCount()) player.removeMediaItems(index+1,player.getMediaItemCount());
        if (index>=0 && index+1<queue.size()) queue.subList(index+1,queue.size()).clear();
        artwork.update(queue,index); model.changed();
        model.io.execute(() -> {
            PandoraProtocol.Modes actual=null;
            try {
                if (!current(request)) return;
                actual=model.api.setStationMode(station,modeId,() -> current(request));
                if (!current(request)) return;
                if (!actual.active(modeId)) throw new Exception("Pandora did not enable that mode. Choose another available mode.");
                if (needsResume) model.api.resume(false); // Already-playing audio keeps its existing approval.
                if (!current(request)) return;
                List<PandoraProtocol.Track> tracks=model.api.playlist(station,false);
                if (!current(request)) return;
                actual=model.api.stationModes(station);
                if (!current(request)) return;
                if (!actual.active(modeId)) throw new Exception("Pandora did not keep that mode active. Please try another mode.");
                if (tracks.isEmpty()) throw new Exception("The mode changed, but a new song could not load. Tap Next to retry.");
                PandoraProtocol.Modes confirmed=actual;
                model.main.post(() -> {
                    if (!current(request)) return;
                    model.rememberCurrent(); player.pause(); artwork.clear(); queue.clear(); seen.clear(); player.clearMediaItems();
                    model.track=null; model.modes=confirmed; reportedToken="";
                    append(tracks); model.modeChanging=false; player.prepare();
                    if (wantPlayback) {
                        // A Pause then Play during tuning queued a server pause.
                        // Approve the latest Play after that pause has completed.
                        if (approvalRevision!=resumeRevision) resume(false); else player.play();
                    }
                    model.changed();
                    if (queue.size()-player.getCurrentMediaItemIndex()<=2) refill();
                });
            } catch (Exception error) {
                PandoraProtocol.Modes latest=actual;
                model.main.post(() -> {
                    if (!current(request)) return;
                    model.modeChanging=false; if (latest!=null) model.modes=latest; wantPlayback=player.getPlayWhenReady();
                    model.modeError=error.getMessage()==null ? "Could not change the station mode. Please try again." : error.getMessage();
                    if (error instanceof PandoraClient.ApiException api && (api.conflict() || api.expired() || api.verification())) pausePlayback(false);
                    model.fail(error,() -> { if (model.station!=null && station.equals(model.station.id)) changeMode(modeId); });
                });
            }
        });
    }
    private void append(List<PandoraProtocol.Track> tracks) {
        List<MediaItem> items = new ArrayList<>();
        for (PandoraProtocol.Track track : tracks) {
            if (!seen.add(track.token)) continue;
            if (track.stationId.isEmpty()) track.stationId = model.station.id;
            queue.add(track);
            MediaMetadata.Builder metadata = new MediaMetadata.Builder().setTitle(track.title).setArtist(track.artist).setAlbumTitle(track.album);
            if (!track.art.isEmpty()) metadata.setArtworkUri(Uri.parse(track.art));
            items.add(new MediaItem.Builder().setMediaId(track.token).setUri(track.audio).setMediaMetadata(metadata.build()).build());
        }
        player.addMediaItems(items);
        artwork.update(queue,player.getCurrentMediaItemIndex());
    }
    private void currentChanged() {
        int index = player.getCurrentMediaItemIndex();
        if (index < 0 || index >= queue.size()) return;
        PandoraProtocol.Track next = queue.get(index);
        if (model.track != null && model.track != next) {
            model.rememberCurrent();
        }
        model.track = next; reportedToken = ""; model.changed();
        artwork.update(queue,index);
        if (player.isPlaying()) reportStarted();
        if (queue.size() - index <= 2) refill();
    }
    private void reportStarted() {
        if (model.track == null || model.station == null || model.track.token.equals(reportedToken)) return;
        reportedToken = model.track.token;
        String token = reportedToken, station = model.station.id; int request = generation, revision=resumeRevision;
        model.io.execute(() -> {
            try { model.api.started(station, token); }
            catch (Exception e) { model.main.post(() -> {
                if (!current(request) || revision!=resumeRevision || model.track==null || !token.equals(model.track.token)) return;
                if (e instanceof PandoraClient.ApiException api && (api.conflict() || api.expired() || api.verification())) { pausePlayback(false); model.fail(e, () -> resume(false)); }
            }); }
        });
    }
    private void refill() {
        if (fetching || model.modeChanging || model.station == null || !model.signedIn || model.takeover || destroyed) return;
        fetching = true; int request = generation; String station = model.station.id;
        model.io.execute(() -> {
            try {
                List<PandoraProtocol.Track> tracks = model.api.playlist(station, false);
                model.main.post(() -> {
                    if (!current(request)) return;
                    fetching = false; int count = queue.size(); boolean ended = player.getPlaybackState() == Player.STATE_ENDED;
                    append(tracks);
                    if (queue.size() == count) { advanceAfterRefill=false; model.message = "No more songs were returned. Tap Play or choose a station to retry."; model.changed(); return; }
                    if (ended || advanceAfterRefill) { advanceAfterRefill=false; player.seekTo(count, 0); player.prepare(); if (wantPlayback) player.play(); }
                });
            } catch (Exception e) { model.main.post(() -> {
                if (!current(request)) return;
                fetching = false; advanceAfterRefill=false;
                if (e instanceof PandoraClient.ApiException api && (api.conflict() || api.expired() || api.verification())) pausePlayback(false);
                model.fail(e, this::refill);
            }); }
        });
    }
    void clearPlayback() {
        ++generation; fetching=true; pausePlayback(); resetModes(); advanceAfterRefill=false; artwork.clear(); queue.clear(); seen.clear();
        model.track = null; model.station = null; model.playing = false; model.loading = false;
        player.stop(); player.clearMediaItems(); fetching=false;
    }
    @Override public void onTaskRemoved(@Nullable Intent rootIntent) {
        model.rememberCurrent();
        // Invalidate pending playlist/resume callbacks before stopping the player.
        clearPlayback();
        // Disconnect bound system controllers so they cannot retain this service.
        if (session != null) { session.release(); session = null; }
        pauseAllPlayersAndStopSelf();
    }
    @Override public void onDestroy() {
        destroyed = true; ++generation; ++resumeRevision;
        resetModes();
        if (artwork != null) artwork.clear();
        if (session != null) session.release();
        if (player != null) player.release();
        if (model != null) { model.playback = null; model.playing = model.loading = false; model.changed(); }
        super.onDestroy();
    }
}
