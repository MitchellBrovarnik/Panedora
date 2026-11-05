package app.panedora.mobile;

import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageButton;
import android.widget.ScrollView;
import androidx.media3.common.util.UnstableApi;
import androidx.test.core.app.ActivityScenario;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.concurrent.atomic.AtomicReference;
import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.action.ViewActions.click;
import static androidx.test.espresso.matcher.ViewMatchers.*;
import static org.hamcrest.Matchers.allOf;
import static org.junit.Assert.*;

@UnstableApi
@RunWith(AndroidJUnit4.class)
public class PlayerControlsTest {
    private static void ui(Runnable task) { InstrumentationRegistry.getInstrumentation().runOnMainSync(task); }
    interface Condition { boolean get(); }
    private static void await(Condition condition) throws Exception {
        long deadline = System.currentTimeMillis() + 20000;
        while (System.currentTimeMillis() < deadline) {
            AtomicReference<Boolean> result = new AtomicReference<>(); ui(() -> result.set(condition.get()));
            if (Boolean.TRUE.equals(result.get())) return; Thread.sleep(50);
        }
        fail("Player controls did not reach the expected state");
    }
    private static String audio(Context context) throws Exception {
        int bytes = 8000 * 2 * 60; ByteBuffer buffer = ByteBuffer.allocate(44 + bytes).order(ByteOrder.LITTLE_ENDIAN);
        buffer.put("RIFF".getBytes()).putInt(36+bytes).put("WAVEfmt ".getBytes()).putInt(16).putShort((short)1).putShort((short)1);
        buffer.putInt(8000).putInt(16000).putShort((short)2).putShort((short)16).put("data".getBytes()).putInt(bytes);
        File file = new File(context.getCacheDir(),"controls-song.wav"); try (var out = new FileOutputStream(file)) { out.write(buffer.array()); }
        return Uri.fromFile(file).toString();
    }
    private static void screenshot(Context context,String name) throws Exception {
        InstrumentationRegistry.getInstrumentation().waitForIdleSync(); Thread.sleep(300);
        String output = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir");
        if (output == null) return; File folder = new File(output,"screenshots"); folder.mkdirs();
        Bitmap image = InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
        try (var out = new FileOutputStream(new File(folder,name+".png"))) { image.compress(Bitmap.CompressFormat.PNG,100,out); }
    }
    @Test public void playPauseKeepsTheViewsAndHistoryRatingsDoNotInterruptPlayback() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        InstrumentationRegistry.getInstrumentation().getUiAutomation().grantRuntimePermission(context.getPackageName(),android.Manifest.permission.POST_NOTIFICATIONS);
        PlaybackSmokeTest.FakePandora fake = new PlaybackSmokeTest.FakePandora(audio(context)); AtomicReference<AppModel> modelRef = new AtomicReference<>();
        ui(() -> { AppModel model = AppModel.get(context); model.credentials.clear(); model.api = fake; model.signedIn = true; model.stations = fake.stations(); modelRef.set(model); });
        AppModel model = modelRef.get();
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> activity = new AtomicReference<>(); scenario.onActivity(activity::set);
            await(() -> model.playback != null); onView(withContentDescription("Play Night Drive Radio")).perform(click());
            await(() -> model.playing && model.track != null);
            AtomicReference<View> root = new AtomicReference<>(), cover = new AtomicReference<>(); AtomicReference<Integer> scroll = new AtomicReference<>();
            ui(() -> { root.set(((ViewGroup)activity.get().findViewById(android.R.id.content)).getChildAt(0)); cover.set(activity.get().findViewById(R.id.current_artwork)); scroll.set(((ScrollView)activity.get().findViewById(R.id.page_scroll)).getScrollY()); });
            onView(withId(R.id.play_pause)).perform(click()); await(() -> !model.playing);
            onView(withId(R.id.play_pause)).perform(click()); await(() -> model.playing);
            ui(() -> {
                assertSame("Play/pause keeps the same screen",root.get(),((ViewGroup)activity.get().findViewById(android.R.id.content)).getChildAt(0));
                assertSame("Artwork is not recreated",cover.get(),activity.get().findViewById(R.id.current_artwork));
                assertEquals("Scroll position stays fixed",scroll.get().intValue(),((ScrollView)activity.get().findViewById(R.id.page_scroll)).getScrollY());
                assertTrue(activity.get().findViewById(R.id.thumb_up) instanceof ImageButton);
            });
            PandoraProtocol.Track first = model.track;
            onView(withId(R.id.thumb_up)).perform(click()); await(() -> !model.feedbackBusy && first.rating == 1);
            onView(withId(R.id.thumb_up)).perform(click()); await(() -> !model.feedbackBusy && first.rating == 0);
            assertTrue("Undo calls Pandora's delete endpoint with its feedback ID",fake.removed.contains("feedback-" + first.token));
            screenshot(context,"player-controls");
            ui(() -> model.playback.next()); await(() -> model.playing && model.track != first);
            PandoraProtocol.Track current = model.track; onView(withId(R.id.nav_history)).perform(click());
            onView(allOf(withContentDescription("Thumbs down"),isDescendantOfA(withContentDescription("History: " + first.title)))).perform(click());
            await(() -> !model.feedbackBusy && first.rating == -1);
            assertTrue(fake.feedback.contains(first.token + ":false"));
            assertSame("Rating history keeps the current song",current,model.track); assertTrue("Music continues",model.playing);
            onView(allOf(withContentDescription("Undo thumbs down"),isDescendantOfA(withContentDescription("History: " + first.title)))).perform(click());
            await(() -> !model.feedbackBusy && first.rating == 0); assertSame(current,model.track);
            screenshot(context,"history-controls");
            ui(model::logout);
        } finally { ui(model::logout); context.stopService(new Intent(context,PlaybackService.class)); }
    }
}
