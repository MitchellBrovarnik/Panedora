package app.panedora.mobile;

import android.content.Context;
import android.content.Intent;
import androidx.media3.common.util.UnstableApi;
import androidx.test.core.app.ActivityScenario;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.action.ViewActions.click;
import static androidx.test.espresso.assertion.ViewAssertions.matches;
import static androidx.test.espresso.matcher.ViewMatchers.*;
import static org.junit.Assert.*;

@UnstableApi
@RunWith(AndroidJUnit4.class)
public class ShufflePlaybackTest {
    private static void ui(Runnable task) { InstrumentationRegistry.getInstrumentation().runOnMainSync(task); }
    interface Condition { boolean get(); }
    private static void await(Condition condition) throws Exception {
        long deadline = System.currentTimeMillis()+20000;
        while (System.currentTimeMillis()<deadline) {
            AtomicReference<Boolean> value = new AtomicReference<>(); ui(() -> value.set(condition.get()));
            if (Boolean.TRUE.equals(value.get())) return; Thread.sleep(50);
        }
        fail("Shuffle did not reach the expected state");
    }
    private static final class ShufflePandora extends PlaybackSmokeTest.FakePandora {
        final List<String> requested = new CopyOnWriteArrayList<>();
        final CountDownLatch waiting = new CountDownLatch(1), release;
        ShufflePandora(String audio,boolean blocked) { super(audio); release = new CountDownLatch(blocked ? 1 : 0); }
        @Override public PandoraProtocol.Station shuffleStation() {
            waiting.countDown();
            try { if (!release.await(15,TimeUnit.SECONDS)) throw new AssertionError("Shuffle fixture stalled"); }
            catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new AssertionError(e); }
            return super.shuffleStation();
        }
        @Override public List<PandoraProtocol.Track> playlist(String station,boolean first) {
            requested.add(station); var tracks = super.playlist(station,first);
            for (var track : tracks) track.stationId = "station"; // Underlying station provided by Pandora.
            return tracks;
        }
    }
    @Test public void shuffleUsesPandorasStationAndSurvivesRefreshingTheList() throws Exception { exercise(false); }
    @Test public void aLateShuffleCannotReplaceANewerStationChoice() throws Exception { exercise(true); }
    private void exercise(boolean pending) throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        InstrumentationRegistry.getInstrumentation().getUiAutomation().grantRuntimePermission(context.getPackageName(),android.Manifest.permission.POST_NOTIFICATIONS);
        ShufflePandora fake = new ShufflePandora(PlaybackSmokeTest.silentWav(context,60),pending); AtomicReference<AppModel> reference = new AtomicReference<>();
        ui(() -> { AppModel model = AppModel.get(context); model.credentials.clear(); model.api = fake; model.signedIn = true; model.stations = fake.stations(); reference.set(model); });
        AppModel model = reference.get();
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            await(() -> model.playback != null); onView(withId(R.id.shuffle_stations)).perform(click());
            assertTrue(fake.waiting.await(5,TimeUnit.SECONDS));
            if (pending) {
                onView(withId(R.id.nav_stations)).perform(click());
                onView(withContentDescription("Play Night Drive Radio")).perform(click()); fake.release.countDown();
                await(() -> model.playing && model.track != null && "station".equals(model.station.id));
                assertFalse("Discarded shuffle never requests an old playlist",fake.requested.contains("shuffle-station"));
            } else {
                await(() -> model.playing && model.track != null && model.station.shuffle);
                assertEquals("shuffle-station",model.station.id); assertTrue(fake.requested.contains("shuffle-station"));
                assertFalse(fake.requested.contains("")); assertEquals("station",model.track.stationId);
                assertEquals(1,model.stations.stream().filter(s -> s.shuffle).count());
                onView(withId(R.id.nav_stations)).perform(click()); ui(model::refreshStations); await(() -> !model.busy);
                onView(withId(R.id.shuffle_stations)).check(matches(isDisplayed()));
            }
        } finally { fake.release.countDown(); ui(model::logout); context.stopService(new Intent(context,PlaybackService.class)); }
    }
}
