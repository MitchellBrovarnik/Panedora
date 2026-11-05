package app.panedora.mobile;

import android.content.Context;
import android.content.Intent;
import androidx.media3.common.util.UnstableApi;
import androidx.test.core.app.ActivityScenario;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.action.ViewActions.click;
import static androidx.test.espresso.assertion.ViewAssertions.doesNotExist;
import static androidx.test.espresso.assertion.ViewAssertions.matches;
import static androidx.test.espresso.matcher.ViewMatchers.*;
import static org.junit.Assert.*;

/** Stateful server fixture: approvals, pauses, starts, and foreign ownership matter. */
@UnstableApi
@RunWith(AndroidJUnit4.class)
public class PlaybackOwnershipTest {
    private final Context context=ApplicationProvider.getApplicationContext();
    private AppModel model;
    private OwnershipPandora fake;
    private static void ui(Runnable task) { InstrumentationRegistry.getInstrumentation().runOnMainSync(task); }
    private static void await(BooleanSupplier condition) throws Exception {
        long deadline=System.currentTimeMillis()+15000;
        while (System.currentTimeMillis()<deadline) {
            AtomicReference<Boolean> value=new AtomicReference<>(); ui(() -> value.set(condition.getAsBoolean()));
            if (Boolean.TRUE.equals(value.get())) return; Thread.sleep(50);
        }
        fail("Playback ownership did not reach the expected state");
    }
    private void drain() throws Exception {
        CountDownLatch done=new CountDownLatch(1); model.io.execute(() -> model.main.post(done::countDown));
        assertTrue(done.await(5,TimeUnit.SECONDS));
    }
    private static final class OwnershipPandora extends PlaybackSmokeTest.FakePandora {
        final List<String> events=new CopyOnWriteArrayList<>();
        final ConcurrentHashMap<String,Integer> starts=new ConcurrentHashMap<>();
        final AtomicInteger modeReads=new AtomicInteger(), forced=new AtomicInteger(), foreignPauses=new AtomicInteger();
        final CountDownLatch entered=new CountDownLatch(1), release=new CountDownLatch(1);
        final CountDownLatch modeEntered=new CountDownLatch(1), modeRelease=new CountDownLatch(1);
        volatile boolean foreign, active, blockNextResume, rejectForce, blockMode;
        volatile long mode=2;
        OwnershipPandora(String audio) { super(audio); }
        private PandoraClient.ApiException conflict() throws Exception { return new PandoraClient.ApiException(409,new JSONObject().put("errorString","STREAM_VIOLATION"),PandoraClient.ORIGIN); }
        @Override public void resume(boolean force) throws Exception {
            events.add("resume:"+force); if (force) forced.incrementAndGet();
            if (blockNextResume) { blockNextResume=false; entered.countDown(); if (!release.await(15,TimeUnit.SECONDS)) throw new Exception("Resume fixture stalled"); }
            if (force && rejectForce || !force && (foreign || active)) throw conflict();
            if (force) foreign=false;
            active=true;
        }
        @Override public void paused(String station,String token) {
            events.add("pause"); if (foreign) foreignPauses.incrementAndGet(); else active=false;
        }
        @Override public void started(String station,String token) throws Exception {
            events.add("start:"+token);
            if (starts.merge(token,1,Integer::sum)>1 || foreign || !active) throw conflict();
        }
        @Override public PandoraProtocol.Modes stationModes(String station) throws Exception {
            modeReads.incrementAndGet(); if (foreign) throw conflict();
            return new PandoraProtocol.Modes(true,mode,java.util.Arrays.asList(
                new PandoraProtocol.Mode(0,"My Station","Your mix.",true,false),
                new PandoraProtocol.Mode(2,"Discovery","Discover more artists.",true,false)));
        }
        @Override public PandoraProtocol.Modes setStationMode(String station,long selected,BooleanSupplier current) throws Exception {
            if (!current.getAsBoolean()) throw new java.util.concurrent.CancellationException();
            if (blockMode) { modeEntered.countDown(); if (!modeRelease.await(15,TimeUnit.SECONDS)) throw new Exception("Mode fixture stalled"); }
            mode=selected; return stationModes(station);
        }
        @Override public List<PandoraProtocol.Track> playlist(String station,boolean first) {
            events.add("playlist:"+first); List<PandoraProtocol.Track> result=new ArrayList<>();
            for (var track:super.playlist(station,first)) result.add(new PandoraProtocol.Track(track.token,track.title,track.artist,track.album,track.audio,"",60,0));
            return result;
        }
    }
    private void prepare() throws Exception {
        InstrumentationRegistry.getInstrumentation().getUiAutomation().grantRuntimePermission(context.getPackageName(),android.Manifest.permission.POST_NOTIFICATIONS);
        fake=new OwnershipPandora(PlaybackSmokeTest.silentWav(context,60));
        ui(() -> { model=AppModel.get(context); model.credentials.clear(); model.api=fake; model.signedIn=true; model.stations=fake.stations(); });
    }
    private void start() throws Exception {
        await(() -> model.playback!=null); onView(withContentDescription("Play Night Drive Radio")).perform(click());
        await(() -> model.playing && model.track!=null); drain();
    }
    @After public void stop() throws Exception {
        if (fake!=null) { fake.release.countDown(); fake.modeRelease.countDown(); }
        if (model!=null) { ui(model::logout); context.stopService(new Intent(context,PlaybackService.class)); drain(); }
    }
    @Test public void pauseResumeAndPlayingModeChangesDoNotReclaimOrRestartTheSameTrack() throws Exception {
        prepare();
        try (ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            start(); PandoraProtocol.Track first=model.track;
            onView(withId(R.id.tune_station)).perform(click()); await(() -> model.modes!=null && !model.modesLoading);
            onView(withContentDescription("Choose My Station")).perform(click());
            await(() -> model.playing && model.track!=first && !model.modeChanging); drain();
            assertEquals("An already-playing mode change reuses its approval",1,fake.events.stream().filter(e -> e.startsWith("resume:")).count());
            PandoraProtocol.Track current=model.track;
            for (int i=0;i<3;i++) {
                ui(() -> model.playback.pausePlayback()); await(() -> !model.playing); drain();
                ui(() -> { model.playback.resume(false); model.playback.resume(false); }); await(() -> model.playing); drain();
                assertSame("Resume preserves the current song",current,model.track);
                assertFalse(model.takeover); assertTrue(model.modeError.isEmpty()); assertTrue(model.modes.active(0));
            }
            long approvals=fake.events.stream().filter(e -> e.startsWith("resume:")).count();
            ui(() -> { model.playback.resume(false); model.playback.resume(false); }); drain();
            assertEquals(approvals,fake.events.stream().filter(e -> e.startsWith("resume:")).count());
            assertEquals("Each track is reported once, across all resumes",Integer.valueOf(1),fake.starts.get(current.token));
            assertEquals(4,approvals); assertEquals(0,fake.forced.get());
        }
    }
    @Test public void playHereAutomaticallyRecoversCachedTuningErrorsAndUsesAFreshApprovedQueue() throws Exception {
        prepare();
        try (ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            start(); ui(() -> model.playback.loadModes(false)); await(() -> model.modes!=null); PandoraProtocol.Track old=model.track;
            fake.foreign=true; ui(() -> model.playback.loadModes(true)); await(() -> model.takeover && !model.playing && !model.modeError.isEmpty());
            assertEquals("Stopping for a foreign stream never pauses that device",0,fake.foreignPauses.get());
            onView(withText("Play here instead")).perform(click());
            await(() -> model.playing && model.track!=old && !model.takeover && model.modes!=null && !model.modesLoading && model.modeError.isEmpty()); drain();
            assertEquals(1,fake.forced.get()); assertEquals(2,fake.fragments.get()); assertTrue(fake.modeReads.get()>=3);
            onView(withId(R.id.tune_station)).perform(click());
            onView(withContentDescription("Choose My Station")).check(matches(isDisplayed()));
            onView(withText("Pandora is playing on another device.")).check(doesNotExist());
            NavigationLayoutTest.screenshot(context,"takeover-tuning-recovered");
        }
    }
    @Test public void pausingAPendingApprovalReleasesItBeforeTheNextResume() throws Exception {
        prepare();
        try (ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            start(); PandoraProtocol.Track track=model.track;
            ui(() -> model.playback.pausePlayback()); drain(); assertFalse(fake.active);
            fake.blockNextResume=true; ui(() -> model.playback.resume(false)); assertTrue(fake.entered.await(5,TimeUnit.SECONDS));
            ui(() -> model.playback.pausePlayback()); fake.release.countDown(); drain();
            ui(() -> { assertFalse(model.playing); assertFalse(model.playback.wantsPlayback()); });
            assertFalse("The cancelled approval is paused on Pandora too",fake.active);
            assertEquals("pause",fake.events.get(fake.events.size()-1));
            ui(() -> model.playback.resume(false)); await(() -> model.playing); drain();
            assertFalse(model.takeover); assertSame(track,model.track); assertEquals(Integer.valueOf(1),fake.starts.get(track.token)); assertEquals(0,fake.forced.get());
        }
    }
    @Test public void rejectedTakeoverStaysPausedAndNeverRetriesWithoutAnotherExplicitChoice() throws Exception {
        prepare();
        try (ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            start(); ui(() -> model.playback.pausePlayback()); drain(); fake.foreign=true; fake.rejectForce=true;
            ui(() -> model.playback.resume(false)); await(() -> model.takeover);
            onView(withText("Play here instead")).perform(click()); await(() -> model.takeover && !model.loading); drain();
            long approvals=fake.events.stream().filter(e -> e.startsWith("resume:")).count();
            ui(() -> { assertFalse(model.playing); assertFalse(model.playback.wantsPlayback()); model.playback.resume(false); model.playback.resume(false); }); drain();
            assertEquals(1,fake.forced.get()); assertEquals(1,fake.fragments.get()); assertTrue(fake.foreign);
            assertEquals(approvals,fake.events.stream().filter(e -> e.startsWith("resume:")).count()); assertEquals(0,fake.foreignPauses.get());
        }
    }
    @Test public void pausingBeforeTheFirstTrackLoadsAlsoReleasesItsLateServerApproval() throws Exception {
        prepare(); fake.blockNextResume=true;
        try (ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            await(() -> model.playback!=null); onView(withContentDescription("Play Night Drive Radio")).perform(click());
            assertTrue(fake.entered.await(5,TimeUnit.SECONDS)); ui(() -> model.playback.pausePlayback());
            fake.release.countDown(); await(() -> model.track!=null && !model.loading); drain();
            ui(() -> { assertFalse(model.playing); assertFalse(model.playback.wantsPlayback()); });
            assertFalse(fake.active);
            ui(() -> model.playback.resume(false)); await(() -> model.playing); drain();
            assertFalse(model.takeover); assertEquals(0,fake.forced.get());
        }
    }
    @Test public void pauseThenPlayDuringTuningApprovesTheNewMixAfterItsQueuedPause() throws Exception {
        prepare();
        try (ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            start(); ui(() -> model.playback.loadModes(false)); await(() -> model.modes!=null);
            fake.blockMode=true; ui(() -> model.playback.changeMode(0)); assertTrue(fake.modeEntered.await(5,TimeUnit.SECONDS));
            ui(() -> { model.playback.pausePlayback(); model.playback.resume(false); }); fake.modeRelease.countDown();
            await(() -> model.playing && !model.modeChanging && model.modes.active(0)); drain();
            assertTrue(fake.active); assertFalse(model.takeover); assertEquals(0,fake.forced.get());
            assertEquals("The latest Play follows the queued Pause",2,fake.events.stream().filter(e -> e.equals("resume:false")).count());
        }
    }
}
