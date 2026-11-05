package app.panedora.mobile;

import android.app.Activity;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import androidx.media3.common.util.UnstableApi;
import androidx.test.core.app.ActivityScenario;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.action.ViewActions.click;
import static androidx.test.espresso.matcher.ViewMatchers.withContentDescription;
import static org.junit.Assert.*;

@UnstableApi
@RunWith(AndroidJUnit4.class)
public class TaskRemovalTest {
    private static void ui(Runnable task) { InstrumentationRegistry.getInstrumentation().runOnMainSync(task); }
    interface Condition { boolean get(); }
    private static void await(Condition condition) throws Exception {
        long deadline = System.currentTimeMillis() + 20000;
        while (System.currentTimeMillis() < deadline) {
            AtomicReference<Boolean> result = new AtomicReference<>(); ui(() -> result.set(condition.get()));
            if (Boolean.TRUE.equals(result.get())) return;
            Thread.sleep(50);
        }
        fail("Task removal did not reach the expected state");
    }
    private static final class GatedPandora extends PlaybackSmokeTest.FakePandora {
        volatile boolean blockResume;
        final CountDownLatch waiting = new CountDownLatch(1), release = new CountDownLatch(1), finished = new CountDownLatch(1);
        GatedPandora(String audio) { super(audio); }
        @Override public void resume(boolean takeOver) {
            if (!blockResume) return;
            waiting.countDown();
            try { if (!release.await(15,TimeUnit.SECONDS)) throw new AssertionError("Resume fixture was not released"); }
            catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new AssertionError(e); }
            finally { finished.countDown(); }
        }
    }
    @Test public void removingTheTaskStopsMusicAndItsNotificationWithoutSigningOut() throws Exception {
        exercise(false);
    }
    @Test public void aLateResumeCannotRestartPlaybackAfterTaskRemoval() throws Exception {
        exercise(true);
    }
    private void exercise(boolean pendingResume) throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        InstrumentationRegistry.getInstrumentation().getUiAutomation().grantRuntimePermission(context.getPackageName(),android.Manifest.permission.POST_NOTIFICATIONS);
        GatedPandora fake = new GatedPandora(PlaybackSmokeTest.silentWav(context)); AtomicReference<AppModel> reference = new AtomicReference<>();
        ui(() -> { AppModel model = AppModel.get(context); model.credentials.clear(); model.api = fake; model.signedIn = true; model.stations = fake.stations(); reference.set(model); });
        AppModel model = reference.get(); NotificationManager notifications = context.getSystemService(NotificationManager.class);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            await(() -> model.playback != null); onView(withContentDescription("Play Night Drive Radio")).perform(click());
            await(() -> model.playing && model.track != null && notifications.getActiveNotifications().length > 0);
            if (pendingResume) {
                ui(() -> model.playback.pausePlayback()); await(() -> !model.playing);
                fake.blockResume = true; ui(() -> model.playback.resume(false));
                assertTrue("Resume is still waiting on the network",fake.waiting.await(5,TimeUnit.SECONDS));
            }
            // Use Android's task-removal API; do not call the service callback ourselves.
            scenario.onActivity(Activity::finishAndRemoveTask);
            await(() -> model.playback == null && model.track == null && model.station == null && !model.playing && !model.loading && notifications.getActiveNotifications().length == 0);
            assertTrue("Closing the app keeps sign-in",model.signedIn);
            if (pendingResume) {
                fake.release.countDown(); assertTrue(fake.finished.await(5,TimeUnit.SECONDS));
                CountDownLatch drained = new CountDownLatch(1); model.io.execute(() -> model.main.post(drained::countDown));
                assertTrue("Late callbacks reached the main queue",drained.await(5,TimeUnit.SECONDS));
            }
            ui(() -> { assertNull("No service restart",model.playback); assertNull(model.track); assertFalse(model.playing); });
            try (ActivityScenario<MainActivity> reopened = ActivityScenario.launch(MainActivity.class)) {
                await(() -> model.playback != null);
                ui(() -> { assertTrue(model.signedIn); assertNull(model.track); assertFalse("Reopening waits for a station choice",model.playback.wantsPlayback()); });
            }
        } finally {
            fake.release.countDown(); ui(model::logout); context.stopService(new Intent(context,PlaybackService.class));
        }
    }
}
