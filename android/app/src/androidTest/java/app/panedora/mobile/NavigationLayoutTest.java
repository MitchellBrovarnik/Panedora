package app.panedora.mobile;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Shader;
import android.view.View;
import androidx.media3.common.util.UnstableApi;
import androidx.test.core.app.ActivityScenario;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.bumptech.glide.Glide;
import com.bumptech.glide.Priority;
import com.bumptech.glide.load.DataSource;
import com.bumptech.glide.load.Options;
import com.bumptech.glide.load.data.DataFetcher;
import com.bumptech.glide.load.model.GlideUrl;
import com.bumptech.glide.load.model.ModelLoader;
import com.bumptech.glide.load.model.ModelLoaderFactory;
import com.bumptech.glide.load.model.MultiModelLoaderFactory;
import com.bumptech.glide.signature.ObjectKey;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.Espresso.pressBack;
import static androidx.test.espresso.action.ViewActions.click;
import static androidx.test.espresso.action.ViewActions.closeSoftKeyboard;
import static androidx.test.espresso.action.ViewActions.replaceText;
import static androidx.test.espresso.action.ViewActions.scrollTo;
import static androidx.test.espresso.assertion.ViewAssertions.matches;
import static androidx.test.espresso.matcher.ViewMatchers.*;
import static org.junit.Assert.*;

/** Exercises the replacement navigation and captures real native layouts for review. */
@UnstableApi
@RunWith(AndroidJUnit4.class)
public class NavigationLayoutTest {
    private static void ui(Runnable task) { InstrumentationRegistry.getInstrumentation().runOnMainSync(task); }
    interface Condition { boolean get(); }
    private static void await(Condition condition) throws Exception {
        long deadline = System.currentTimeMillis()+15000;
        while (System.currentTimeMillis()<deadline) {
            AtomicReference<Boolean> result = new AtomicReference<>(); ui(() -> result.set(condition.get()));
            if (Boolean.TRUE.equals(result.get())) return; Thread.sleep(50);
        }
        fail("Navigation did not reach the expected state");
    }
    private static void screenshot(Context context,String name) throws Exception {
        InstrumentationRegistry.getInstrumentation().waitForIdleSync(); Thread.sleep(300);
        String output = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir");
        if (output == null) return;
        File folder = new File(output,"screenshots"); assertTrue(folder.isDirectory() || folder.mkdirs());
        Bitmap image = InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
        try (var out = new FileOutputStream(new File(folder,"redesign-"+name+".png"))) { image.compress(Bitmap.CompressFormat.PNG,100,out); }
        image.recycle();
    }
    private static void installArtwork(Context context) {
        Bitmap image = Bitmap.createBitmap(640,640,Bitmap.Config.ARGB_8888); Canvas canvas = new Canvas(image); Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setShader(new LinearGradient(0,0,640,640,new int[]{0xff142b42,0xff815884,0xffe6ae8a},null,Shader.TileMode.CLAMP)); canvas.drawRect(0,0,640,640,paint); paint.setShader(null);
        paint.setColor(0xfff7d6ad); canvas.drawCircle(430,220,96,paint);
        paint.setColor(0xff332e57); canvas.drawOval(-160,340,780,1000,paint); paint.setColor(0xff1c233a); canvas.drawOval(-180,440,940,1100,paint);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); image.compress(Bitmap.CompressFormat.PNG,100,bytes); image.recycle(); byte[] source = bytes.toByteArray();
        Glide.get(context).getRegistry().prepend(GlideUrl.class,InputStream.class,new ModelLoaderFactory<GlideUrl,InputStream>() {
            @Override public ModelLoader<GlideUrl,InputStream> build(MultiModelLoaderFactory ignored) {
                return new ModelLoader<GlideUrl,InputStream>() {
                    @Override public boolean handles(GlideUrl model) { return model.toStringUrl().startsWith("https://layout-fixture.invalid/"); }
                    @Override public LoadData<InputStream> buildLoadData(GlideUrl model,int width,int height,Options options) {
                        return new LoadData<>(new ObjectKey(model.toStringUrl()),new DataFetcher<InputStream>() {
                            @Override public void loadData(Priority priority,DataCallback<? super InputStream> callback) { callback.onDataReady(new ByteArrayInputStream(source)); }
                            @Override public void cleanup() {}
                            @Override public void cancel() {}
                            @Override public Class<InputStream> getDataClass() { return InputStream.class; }
                            @Override public DataSource getDataSource() { return DataSource.REMOTE; }
                        });
                    }
                };
            }
            @Override public void teardown() {}
        });
    }
    private static AppModel prepare(Context context) throws Exception {
        InstrumentationRegistry.getInstrumentation().getUiAutomation().grantRuntimePermission(context.getPackageName(),android.Manifest.permission.POST_NOTIFICATIONS);
        PlaybackSmokeTest.FakePandora fake = new PlaybackSmokeTest.FakePandora(PlaybackSmokeTest.silentWav(context,60)) {
            @Override public List<PandoraProtocol.Station> stations() {
                List<PandoraProtocol.Station> result = new ArrayList<>();
                for (String name : new String[]{"Night Drive Radio","Tove Lo Radio","Indie Favorites","Evening Jazz","Northbound Radio","Acoustic Sessions"}) result.add(new PandoraProtocol.Station("station-"+result.size(),name,"https://layout-fixture.invalid/station-"+result.size()+".png"));
                return result;
            }
            @Override public List<PandoraProtocol.Track> playlist(String station,boolean first) {
                List<PandoraProtocol.Track> result = new ArrayList<>();
                for (var track : super.playlist(station,first)) result.add(new PandoraProtocol.Track(track.token,"A Long Way Home (Late Night Session)","Northbound & The Midnight Orchestra","Evening Mix",track.audio,"https://layout-fixture.invalid/album.png",60,0));
                return result;
            }
        };
        AtomicReference<AppModel> reference = new AtomicReference<>();
        ui(() -> { installArtwork(context); AppModel model = AppModel.get(context); model.credentials.clear(); model.api = fake; model.signedIn = true; model.history.clear(); model.stations = fake.stations(); reference.set(model); });
        return reference.get();
    }
    @Test public void libraryMiniPlayerAndFullPlayerNavigateWithoutDuplicateBottomControls() throws Exception {
        Context context = ApplicationProvider.getApplicationContext(); AppModel model = prepare(context);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> activity = new AtomicReference<>(); scenario.onActivity(activity::set);
            await(() -> model.playback != null); screenshot(context,"stations");
            onView(withContentDescription("Play Night Drive Radio")).perform(click()); await(() -> model.playing && model.track != null);
            onView(withId(R.id.thumb_up)).check(matches(isCompletelyDisplayed())); onView(withId(R.id.thumb_down)).check(matches(isCompletelyDisplayed()));
            ui(() -> { assertNull("Full player has no second player strip",activity.get().findViewById(R.id.compact_player)); assertNull("Settings is out of the player controls",activity.get().findViewById(R.id.nav_settings)); });
            screenshot(context,"now-playing");
            onView(withId(R.id.now_title)).perform(click()); onView(withText("Done")).perform(click());
            onView(withId(R.id.nav_stations)).perform(click()); onView(withId(R.id.compact_player)).check(matches(isCompletelyDisplayed()));
            screenshot(context,"stations-playing");
            onView(withId(R.id.compact_play_pause)).perform(click()); await(() -> !model.playing);
            onView(withId(R.id.compact_play_pause)).perform(click()); await(() -> model.playing);
            PandoraProtocol.Track first = model.track; onView(withId(R.id.compact_next)).perform(click()); await(() -> model.track != first && model.playing);
            onView(withId(R.id.nav_playing)).perform(click()); onView(withId(R.id.nav_history)).perform(click()); screenshot(context,"history");
            pressBack(); onView(withId(R.id.current_artwork)).check(matches(isDisplayed()));
            onView(withId(R.id.nav_stations)).perform(click()); onView(withId(R.id.nav_settings)).perform(click()); screenshot(context,"settings");
            scenario.recreate(); pressBack(); onView(withId(R.id.station_search)).check(matches(isDisplayed()));
            onView(withId(R.id.station_search)).perform(replaceText("Night"),closeSoftKeyboard());
            onView(withContentDescription("Play Night Drive Radio")).perform(click()); await(() -> model.track != null && model.playing);
            onView(withId(R.id.nav_stations)).perform(click()); onView(withId(R.id.station_search)).check(matches(withText("Night")));
        } finally { ui(model::logout); context.stopService(new Intent(context,PlaybackService.class)); }
    }
    @Test public void rotatedPlayerKeepsPlaybackControlsReachable() throws Exception {
        Context context = ApplicationProvider.getApplicationContext(); AppModel model = prepare(context);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            await(() -> model.playback != null); onView(withContentDescription("Play Night Drive Radio")).perform(click()); await(() -> model.playing && model.track != null);
            ui(() -> model.playback.pausePlayback());
            scenario.onActivity(activity -> activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));
            await(() -> context.getResources().getConfiguration().orientation == Configuration.ORIENTATION_LANDSCAPE);
            onView(withId(R.id.playback_controls)).perform(scrollTo()); onView(withId(R.id.thumb_up)).check(matches(isCompletelyDisplayed()));
            onView(withId(R.id.play_pause)).perform(click()); await(() -> model.playing); screenshot(context,"landscape-controls");
            scenario.onActivity(activity -> activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
            await(() -> context.getResources().getConfiguration().orientation == Configuration.ORIENTATION_PORTRAIT);
            onView(withId(R.id.nav_stations)).perform(click()); onView(withId(R.id.compact_player)).check(matches(isCompletelyDisplayed()));
        } finally { ui(model::logout); context.stopService(new Intent(context,PlaybackService.class)); }
    }
}
