package app.panedora.mobile;

import android.content.Context;
import android.content.Intent;
import androidx.media3.common.util.UnstableApi;
import androidx.test.core.app.ActivityScenario;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.action.ViewActions.click;
import static androidx.test.espresso.assertion.ViewAssertions.doesNotExist;
import static androidx.test.espresso.assertion.ViewAssertions.matches;
import static androidx.test.espresso.matcher.ViewMatchers.*;
import static org.junit.Assert.*;

@UnstableApi
@RunWith(AndroidJUnit4.class)
public class StationFeaturesTest {
    private final Context context=ApplicationProvider.getApplicationContext();
    private AppModel model;
    private ModesPandora fake;
    private static void ui(Runnable task) { InstrumentationRegistry.getInstrumentation().runOnMainSync(task); }
    private static void await(BooleanSupplier condition) throws Exception {
        long deadline=System.currentTimeMillis()+15000;
        while (System.currentTimeMillis()<deadline) {
            AtomicReference<Boolean> result=new AtomicReference<>(); ui(() -> result.set(condition.getAsBoolean()));
            if (Boolean.TRUE.equals(result.get())) return; Thread.sleep(50);
        }
        fail("Station feature did not reach the expected state");
    }
    private static final class ModesPandora extends PlaybackSmokeTest.FakePandora {
        final Map<String,Long> active=new ConcurrentHashMap<>();
        final List<String> calls=new CopyOnWriteArrayList<>();
        final List<Boolean> takeovers=new CopyOnWriteArrayList<>();
        final CountDownLatch entered=new CountDownLatch(1), release;
        boolean reject;
        ModesPandora(String audio,boolean block) { super(audio); release=new CountDownLatch(block ? 1 : 0); }
        @Override public List<PandoraProtocol.Station> stations() {
            return java.util.Arrays.asList(new PandoraProtocol.Station("station","Night Drive Radio","https://layout-fixture.invalid/night.png"),new PandoraProtocol.Station("other","Acoustic Radio","https://layout-fixture.invalid/acoustic.png"));
        }
        @Override public PandoraProtocol.Modes stationModes(String station) {
            return new PandoraProtocol.Modes(true,active.getOrDefault(station,0L),java.util.Arrays.asList(
                new PandoraProtocol.Mode(0,"My Station","Your personalized mix.",true,false),
                new PandoraProtocol.Mode(2,"Discovery","Find artists you have not heard before.",true,false),
                new PandoraProtocol.Mode(3,"Deep Cuts","Hear more from familiar artists.",true,false),
                new PandoraProtocol.Mode(5,"Artist Only","Only this artist.",false,true)));
        }
        @Override public PandoraProtocol.Modes setStationMode(String station,long mode,BooleanSupplier current) throws Exception {
            assertTrue(current.getAsBoolean()); calls.add("mode:"+station+":"+mode);
            if (!reject) active.put(station,mode); entered.countDown();
            if (!release.await(15,TimeUnit.SECONDS)) throw new Exception("Mode fixture stalled");
            return stationModes(station); // A response already in flight may arrive after switching stations.
        }
        @Override public List<PandoraProtocol.Track> playlist(String station,boolean first) {
            calls.add("playlist:"+station+":"+first); long mode=active.getOrDefault(station,0L);
            List<PandoraProtocol.Track> result=new ArrayList<>();
            for (var track:super.playlist(station,first)) result.add(new PandoraProtocol.Track("mode-"+mode+"-"+track.token,(mode==2 ? "Discovery" : "Night Drive")+" · "+track.title,track.artist,track.album,track.audio,"https://layout-fixture.invalid/album.png",60,0));
            return result;
        }
        @Override public void resume(boolean takeOver) { takeovers.add(takeOver); }
    }
    private void prepare(boolean block) throws Exception {
        InstrumentationRegistry.getInstrumentation().getUiAutomation().grantRuntimePermission(context.getPackageName(),android.Manifest.permission.POST_NOTIFICATIONS);
        fake=new ModesPandora(PlaybackSmokeTest.silentWav(context,60),block);
        ui(() -> { NavigationLayoutTest.installArtwork(context); model=AppModel.get(context); model.credentials.clear(); model.api=fake; model.signedIn=true; model.stations=fake.stations(); });
    }
    private void start() throws Exception {
        await(() -> model.playback!=null); onView(withContentDescription("Play Night Drive Radio")).perform(click()); await(() -> model.playing && model.track!=null);
    }
    @After public void stop() throws Exception {
        if (fake!=null) fake.release.countDown();
        if (model!=null) { ui(model::logout); context.stopService(new Intent(context,PlaybackService.class)); CountDownLatch drained=new CountDownLatch(1); model.io.execute(drained::countDown); assertTrue(drained.await(5,TimeUnit.SECONDS)); }
    }
    @Test public void tuneStartsTheConfirmedMixAndHidesPremiumOnlyChoicesOnPlus() throws Exception {
        prepare(false);
        try (ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            start(); PandoraProtocol.Track old=model.track; ui(() -> model.playback.pausePlayback());
            onView(withId(R.id.tune_station)).perform(click()); await(() -> model.modes!=null && !model.modesLoading);
            onView(withText("Artist Only")).check(doesNotExist()); NavigationLayoutTest.screenshot(context,"station-modes");
            onView(withContentDescription("Choose Discovery")).perform(click()); await(() -> !model.modeChanging && model.playing && model.track!=old && model.track.token.startsWith("mode-2-"));
            assertTrue(model.modes.active(2)); assertTrue(fake.calls.contains("playlist:station:false")); assertFalse(fake.takeovers.contains(true));
            onView(withId(R.id.tune_station)).check(matches(withText("Discovery"))); onView(withId(R.id.thumb_up)).check(matches(isCompletelyDisplayed()));
            NavigationLayoutTest.screenshot(context,"tuned-player");
        }
    }
    @Test public void aLateModeResponseCannotReplaceANewerStation() throws Exception {
        prepare(true);
        try (ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            start(); ui(() -> model.playback.loadModes(false)); await(() -> model.modes!=null);
            ui(() -> model.playback.changeMode(2)); assertTrue(fake.entered.await(5,TimeUnit.SECONDS));
            ui(() -> model.playback.select(model.stations.get(1))); fake.release.countDown();
            await(() -> model.track!=null && model.playing && "other".equals(model.station.id));
            ui(() -> {
                assertNull("A new station clears old mode metadata: "+fake.calls,model.modes);
                assertFalse("A new station is not still changing the old mode: "+fake.calls,model.modeChanging);
                assertTrue("New station token is "+model.track.token+"; calls: "+fake.calls,model.track.token.startsWith("mode-0-"));
                assertFalse("Stale tuning never requests the old station's next mix: "+fake.calls,fake.calls.contains("playlist:station:false"));
            });
        }
    }
    @Test public void pausingDuringAChangeKeepsTheConfirmedNewSongPaused() throws Exception {
        prepare(true);
        try (ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            start(); ui(() -> model.playback.loadModes(false)); await(() -> model.modes!=null);
            ui(() -> model.playback.changeMode(2)); assertTrue(fake.entered.await(5,TimeUnit.SECONDS));
            ui(() -> model.playback.pausePlayback()); fake.release.countDown();
            await(() -> !model.modeChanging && model.track!=null && model.track.token.startsWith("mode-2-"));
            ui(() -> { assertFalse(model.playing); assertFalse(model.playback.wantsPlayback()); assertTrue(model.modes.active(2)); });
        }
    }
    @Test public void rejectedChangesKeepTheCurrentSongAndNextFetchesAFreshQueue() throws Exception {
        prepare(false); fake.reject=true;
        try (ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            start(); ui(() -> model.playback.loadModes(false)); await(() -> model.modes!=null); PandoraProtocol.Track old=model.track;
            ui(() -> model.playback.changeMode(2)); await(() -> !model.modeChanging && !model.modeError.isEmpty());
            assertSame(old,model.track); assertTrue(model.playing); assertFalse(fake.calls.contains("playlist:station:false"));
            ui(() -> model.playback.next()); await(() -> model.track!=old);
            assertTrue("Next advances as soon as refill completes",model.track.token.endsWith("song-4"));
        }
    }
}
