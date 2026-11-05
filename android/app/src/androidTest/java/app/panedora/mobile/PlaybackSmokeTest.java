package app.panedora.mobile;

import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import androidx.lifecycle.Lifecycle;
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
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;
import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.action.ViewActions.click;
import static androidx.test.espresso.assertion.ViewAssertions.matches;
import static androidx.test.espresso.matcher.ViewMatchers.withContentDescription;
import static androidx.test.espresso.matcher.ViewMatchers.withId;
import static androidx.test.espresso.matcher.ViewMatchers.isCompletelyDisplayed;

@UnstableApi
@RunWith(AndroidJUnit4.class)
public class PlaybackSmokeTest {
    private static void ui(Runnable task) { InstrumentationRegistry.getInstrumentation().runOnMainSync(task); }
    interface Condition { boolean get(); }
    private static void await(Condition condition) throws Exception {
        long deadline = System.currentTimeMillis() + 20000;
        while (System.currentTimeMillis() < deadline) {
            AtomicReference<Boolean> result = new AtomicReference<>(); ui(() -> result.set(condition.get()));
            if (Boolean.TRUE.equals(result.get())) return;
            Thread.sleep(100);
        }
        fail("Native player did not reach the expected state within 20 seconds");
    }
    private static void screenshot(Context context, String name) throws Exception {
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
        Thread.sleep(400); // Let the rendered frame catch up to the main-thread state.
        // Gradle collects this directory before uninstalling the test app.
        String output = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir");
        File directory = output == null ? context.getExternalFilesDir("screenshots") : new File(output, "screenshots");
        assertNotNull(directory); assertTrue(directory.isDirectory() || directory.mkdirs());
        Bitmap bitmap = InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
        try (var out = new FileOutputStream(new File(directory,name + ".png"))) { bitmap.compress(Bitmap.CompressFormat.PNG,100,out); }
    }
    static String silentWav(Context context) throws Exception {
        return silentWav(context,3);
    }
    static String silentWav(Context context,int seconds) throws Exception {
        int bytes = 8000 * 2 * seconds;
        ByteBuffer buffer = ByteBuffer.allocate(44 + bytes).order(ByteOrder.LITTLE_ENDIAN);
        buffer.put("RIFF".getBytes()).putInt(36 + bytes).put("WAVEfmt ".getBytes()).putInt(16).putShort((short)1).putShort((short)1);
        buffer.putInt(8000).putInt(16000).putShort((short)2).putShort((short)16).put("data".getBytes()).putInt(bytes);
        File file = new File(context.getCacheDir(),"test-song-" + seconds + ".wav");
        try (var out = new FileOutputStream(file)) { out.write(buffer.array()); }
        return Uri.fromFile(file).toString();
    }
    static class FakePandora implements PandoraGateway {
        final AtomicInteger fragments = new AtomicInteger();
        final List<String> started = new CopyOnWriteArrayList<>();
        final List<String> feedback = new CopyOnWriteArrayList<>();
        final List<String> removed = new CopyOnWriteArrayList<>();
        final String audio;
        FakePandora(String audio) { this.audio = audio; }
        @Override public void login(String email,String password) {}
        @Override public List<PandoraProtocol.Station> stations() { return Collections.singletonList(new PandoraProtocol.Station("station", "Night Drive Radio", "")); }
        @Override public PandoraProtocol.Station shuffleStation() { return new PandoraProtocol.Station("shuffle-station","Shuffle Stations","",true); }
        @Override public PandoraProtocol.Modes stationModes(String station) throws Exception { return PandoraProtocol.Modes.unavailable(); }
        @Override public PandoraProtocol.Modes setStationMode(String station,long mode,java.util.function.BooleanSupplier current) throws Exception { throw new UnsupportedOperationException("No station modes in this fixture"); }
        @Override public List<PandoraProtocol.Track> playlist(String station,boolean first) {
            int block = fragments.getAndIncrement(); List<PandoraProtocol.Track> tracks = new ArrayList<>();
            for (int i = 1; i <= 3; i++) { int n = block * 3 + i; tracks.add(new PandoraProtocol.Track("song-"+n,"After Hours " + n,"Northbound","Evening Mix",audio,"",3,0)); }
            return tracks;
        }
        @Override public void resume(boolean takeOver) throws Exception {}
        @Override public String feedback(String token,boolean positive) { feedback.add(token + ":" + positive); return "feedback-" + token; }
        @Override public void deleteFeedback(String id) { removed.add(id); }
        @Override public void started(String station,String token) { started.add(token); }
        @Override public void paused(String station,String token) {}
        @Override public void clear() {}
    }
    @Test public void nativeQueueContinuesAfterTheScreenClosesAndThumbsTargetCurrentTrack() throws Exception {
        Context context = ApplicationProvider.getApplicationContext(); FakePandora fake = new FakePandora(silentWav(context));
        InstrumentationRegistry.getInstrumentation().getUiAutomation().grantRuntimePermission(context.getPackageName(), android.Manifest.permission.POST_NOTIFICATIONS);
        AtomicReference<AppModel> reference = new AtomicReference<>();
        ui(() -> { AppModel model = AppModel.get(context); model.credentials.clear(); model.api = fake; model.signedIn = true; model.stations = fake.stations(); reference.set(model); });
        AppModel model = reference.get();
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            await(() -> model.playback != null); screenshot(context,"stations");
            onView(withContentDescription("Play Night Drive Radio")).perform(click());
            await(() -> model.playing && model.track != null);
            onView(withId(R.id.thumb_up)).check(matches(isCompletelyDisplayed()));
            screenshot(context,"now-playing");
            AtomicReference<String> thumbToken = new AtomicReference<>();
            ui(() -> { thumbToken.set(model.track.token); model.rate(true); });
            await(() -> fake.feedback.contains(thumbToken.get() + ":true"));
            // Stop the Activity: the native service must fetch and advance the queue itself.
            scenario.moveToState(Lifecycle.State.CREATED);
            await(() -> fake.started.contains("song-4"));
            assertTrue("Refilled playlist without the screen",fake.fragments.get() >= 2);
            assertTrue("All intermediate songs played",fake.started.containsAll(java.util.Arrays.asList("song-1","song-2","song-3")));
            ui(() -> model.playback.pausePlayback());
            await(() -> !model.playing);
            int count = fake.started.size(); Thread.sleep(3500); assertEquals("Pause survives a song-length wait",count,fake.started.size());
            scenario.moveToState(Lifecycle.State.RESUMED);
            await(() -> model.playback != null);
            ui(() -> model.playback.resume(false)); await(() -> model.playing);
            ui(model::logout); await(() -> !model.signedIn && model.track == null && !model.playing);
            screenshot(context,"sign-in");
        } finally { context.stopService(new Intent(context,PlaybackService.class)); }
        // Exercise real Android Keystore encryption, not a stub or a plaintext fallback.
        CredentialStore store = new CredentialStore(context); store.save("fixture@example.invalid","fixture password");
        String raw = context.getSharedPreferences("private-login",Context.MODE_PRIVATE).getString("encrypted","");
        assertFalse(raw.contains("fixture")); assertEquals("fixture password",store.read().getString("password")); store.clear(); assertNull(store.read());
    }
}
