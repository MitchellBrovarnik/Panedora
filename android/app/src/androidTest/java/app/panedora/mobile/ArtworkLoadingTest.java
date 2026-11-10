package app.panedora.mobile;

import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.drawable.BitmapDrawable;
import android.view.View;
import android.widget.ImageView;
import android.widget.SeekBar;
import androidx.core.graphics.ColorUtils;
import androidx.lifecycle.Lifecycle;
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
import com.bumptech.glide.load.engine.executor.GlideExecutor;
import com.bumptech.glide.load.model.GlideUrl;
import com.bumptech.glide.load.model.ModelLoader;
import com.bumptech.glide.load.model.ModelLoaderFactory;
import com.bumptech.glide.load.model.MultiModelLoaderFactory;
import com.bumptech.glide.signature.ObjectKey;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.action.ViewActions.click;
import static androidx.test.espresso.matcher.ViewMatchers.withId;
import static androidx.test.espresso.matcher.ViewMatchers.withContentDescription;
import static androidx.test.espresso.matcher.ViewMatchers.withText;
import static org.junit.Assert.*;

/** Exercises the real image loader/caches with deterministic delayed image responses. */
@UnstableApi
@RunWith(AndroidJUnit4.class)
public class ArtworkLoadingTest {
    private final Context context = ApplicationProvider.getApplicationContext();
    private final Map<String, Fixture> fixtures = new ConcurrentHashMap<>();
    private final List<ImageView> targets = new ArrayList<>();
    private static void ui(Runnable task) { InstrumentationRegistry.getInstrumentation().runOnMainSync(task); }
    interface Condition { boolean get(); }
    private static void await(Condition condition) throws Exception {
        long deadline = System.currentTimeMillis() + 10000;
        while (System.currentTimeMillis() < deadline) {
            AtomicReference<Boolean> result = new AtomicReference<>(); ui(() -> result.set(condition.get()));
            if (Boolean.TRUE.equals(result.get())) return;
            Thread.sleep(50);
        }
        fail("Artwork did not reach the expected state");
    }
    private static boolean hasColor(ImageView image, int color) {
        if (image == null || !(image.getDrawable() instanceof BitmapDrawable drawable)) return false;
        Bitmap bitmap = drawable.getBitmap();
        if (bitmap.getConfig() == Bitmap.Config.HARDWARE) {
            Bitmap copy = bitmap.copy(Bitmap.Config.ARGB_8888, false);
            int actual = copy.getPixel(0,0); copy.recycle(); return actual == color;
        }
        return bitmap.getPixel(0,0) == color;
    }
    private Fixture fixture(int color, boolean blocked) {
        Bitmap bitmap = Bitmap.createBitmap(640,640,Bitmap.Config.ARGB_8888); bitmap.eraseColor(color);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); bitmap.compress(Bitmap.CompressFormat.PNG,100,bytes); bitmap.recycle();
        String url = "https://artwork-fixture.invalid/" + System.nanoTime() + "/" + fixtures.size() + ".png";
        Fixture result = new Fixture(url,bytes.toByteArray(),blocked); fixtures.put(url,result); return result;
    }
    private ImageView target() { ImageView image = new ImageView(context); targets.add(image); return image; }
    @Before public void registerImages() {
        context.getSharedPreferences("appearance",Context.MODE_PRIVATE).edit().clear().commit();
        ui(() -> Glide.get(context).getRegistry().prepend(GlideUrl.class, InputStream.class, new ModelLoaderFactory<GlideUrl,InputStream>() {
            @Override public ModelLoader<GlideUrl,InputStream> build(MultiModelLoaderFactory ignored) {
                return new ModelLoader<GlideUrl,InputStream>() {
                    @Override public boolean handles(GlideUrl model) { return fixtures.containsKey(model.toStringUrl()); }
                    @Override public LoadData<InputStream> buildLoadData(GlideUrl model,int width,int height,Options options) {
                        Fixture fixture = fixtures.get(model.toStringUrl());
                        return new LoadData<>(new ObjectKey(model.toStringUrl()), new DataFetcher<InputStream>() {
                            private volatile boolean cancelled;
                            @Override public void loadData(Priority priority,DataCallback<? super InputStream> callback) {
                                fixture.hits.incrementAndGet(); fixture.started.countDown();
                                try {
                                    if (!fixture.allowNetwork || !fixture.release.await(15,TimeUnit.SECONDS)) throw new Exception("Unexpected or stalled image fetch");
                                    if (!cancelled) callback.onDataReady(new ByteArrayInputStream(fixture.bytes));
                                } catch (Exception e) { if (!cancelled) callback.onLoadFailed(e); }
                            }
                            @Override public void cancel() { cancelled = true; fixture.release.countDown(); }
                            @Override public void cleanup() {}
                            @Override public Class<InputStream> getDataClass() { return InputStream.class; }
                            @Override public DataSource getDataSource() { return DataSource.REMOTE; }
                        });
                    }
                };
            }
            @Override public void teardown() {}
        }));
    }
    @After public void clearTargets() {
        for (Fixture fixture : fixtures.values()) fixture.release.countDown();
        ui(() -> { for (ImageView target : targets) Artwork.clear(target); });
        context.getSharedPreferences("appearance",Context.MODE_PRIVATE).edit().clear().commit();
    }
    private static final class Fixture {
        final String url; final byte[] bytes; final CountDownLatch release, started = new CountDownLatch(1);
        final AtomicInteger hits = new AtomicInteger(); volatile boolean allowNetwork = true;
        Fixture(String url,byte[] bytes,boolean blocked) { this.url = url; this.bytes = bytes; release = new CountDownLatch(blocked ? 1 : 0); }
    }

    @Test public void currentCoverBypassesStalledStationQueueAndSharesRefreshRequests() throws Exception {
        List<Fixture> stations = new ArrayList<>();
        for (int i = 0; i < 12; i++) stations.add(fixture(Color.BLUE,true));
        ui(() -> { for (Fixture station : stations) Artwork.load(target(),station.url,100,false); });
        await(() -> stations.stream().filter(s -> s.started.getCount() == 0).count() >= GlideExecutor.calculateBestThreadCount());
        Fixture current = fixture(Color.GREEN,true);
        AtomicReference<ImageView> first = new AtomicReference<>(), second = new AtomicReference<>(), replacement = new AtomicReference<>();
        ui(() -> {
            first.set(target()); second.set(target()); replacement.set(target());
            Artwork.load(first.get(),current.url,640,true);
            Artwork.load(second.get(),current.url,640,true);
            Artwork.load(replacement.get(),current.url,640,true);
            Artwork.clear(first.get()); // A screen refresh replaces its old target.
        });
        assertTrue("Current cover starts before station downloads are released", current.started.await(5,TimeUnit.SECONDS));
        assertEquals("Refresh targets share one download",1,current.hits.get());
        current.release.countDown();
        await(() -> hasColor(second.get(),Color.GREEN) && hasColor(replacement.get(),Color.GREEN));
        for (Fixture station : stations) assertEquals("Station queue is still deliberately blocked",1,station.release.getCount());
        assertEquals(1,current.hits.get());
    }

    @Test public void mainAndCompactCoversReuseDiskCacheAfterReturningToTheApp() throws Exception {
        Fixture current = fixture(Color.GREEN,false); AtomicReference<ImageView> seed = new AtomicReference<>();
        ui(() -> { seed.set(target()); Artwork.load(seed.get(),current.url,120,true); });
        await(() -> hasColor(seed.get(),Color.GREEN));
        ui(() -> { Artwork.clear(seed.get()); Glide.get(context).clearMemory(); });
        current.allowNetwork = false; // All further sizes and screen returns must use disk.
        AtomicReference<AppModel> modelRef = new AtomicReference<>();
        ui(() -> {
            AppModel model = AppModel.get(context); model.signedIn = true;
            model.station = new PandoraProtocol.Station("art-station","Artwork test station",current.url);
            model.stations = Collections.singletonList(model.station);
            model.track = new PandoraProtocol.Track("art-track","Artwork test song","Test artist","Test album","",current.url,180,0);
            modelRef.set(model);
        });
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> activity = new AtomicReference<>(); scenario.onActivity(activity::set);
            await(() -> hasColor(activity.get().findViewById(R.id.compact_artwork),Color.GREEN));
            onView(withId(R.id.nav_playing)).perform(click());
            await(() -> hasColor(activity.get().findViewById(R.id.current_artwork),Color.GREEN));
            ui(() -> { for (int i = 0; i < 6; i++) modelRef.get().changed(); });
            await(() -> hasColor(activity.get().findViewById(R.id.current_artwork),Color.GREEN));
            ui(() -> Artwork.clear(activity.get().findViewById(android.R.id.content)));
            scenario.moveToState(Lifecycle.State.CREATED);
            ui(() -> Glide.get(context).clearMemory());
            scenario.recreate();
            scenario.moveToState(Lifecycle.State.RESUMED);
            scenario.onActivity(activity::set);
            await(() -> hasColor(activity.get().findViewById(R.id.current_artwork),Color.GREEN));
            assertEquals("Disk cache avoids re-downloading when size or screen changes",1,current.hits.get());
        } finally {
            ui(() -> modelRef.get().logout()); context.stopService(new Intent(context,PlaybackService.class));
        }
    }
    @Test public void queuedCoverAppearsOnSkipWithoutAPlaceholderOrAnotherDownload() throws Exception {
        new Appearance(context).select(Appearance.THEMES[Appearance.THEMES.length-1]);
        Fixture first = fixture(Color.BLUE,false), next = fixture(Color.GREEN,false), third = fixture(Color.RED,false);
        PlaybackSmokeTest.FakePandora fake = new PlaybackSmokeTest.FakePandora(PlaybackSmokeTest.silentWav(context,60)) {
            @Override public List<PandoraProtocol.Track> playlist(String station,boolean start) {
                List<PandoraProtocol.Track> tracks = super.playlist(station,start), result = new ArrayList<>();
                for (int i = 0; i < tracks.size(); i++) {
                    var track = tracks.get(i); String art = i == 0 ? first.url : i == 1 ? next.url : third.url;
                    result.add(new PandoraProtocol.Track(track.token,track.title,track.artist,track.album,track.audio,art,track.seconds,0));
                }
                return result;
            }
        };
        InstrumentationRegistry.getInstrumentation().getUiAutomation().grantRuntimePermission(context.getPackageName(),android.Manifest.permission.POST_NOTIFICATIONS);
        AtomicReference<AppModel> reference = new AtomicReference<>();
        ui(() -> { AppModel model = AppModel.get(context); model.credentials.clear(); model.api = fake; model.signedIn = true; model.stations = fake.stations(); reference.set(model); });
        AppModel model = reference.get();
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> activity = new AtomicReference<>(); scenario.onActivity(activity::set);
            await(() -> model.playback != null); onView(withContentDescription("Play Night Drive Radio")).perform(click());
            await(() -> model.playing && model.track != null); ui(() -> model.playback.pausePlayback());
            await(() -> model.playback.artwork.ready(next.url) && Artwork.accent(next.url)!=null && Artwork.accent(first.url)!=null); next.allowNetwork = false;
            await(() -> playerAccent(activity.get())==new Appearance(context).palette(Color.BLUE).accent);
            NavigationLayoutTest.screenshot(context,"adaptive-blue-player");
            assertEquals("Large/compact preloads share the image download",1,next.hits.get());
            ui(() -> {
                View cover=activity.get().findViewById(R.id.current_artwork), controls=activity.get().findViewById(R.id.playback_controls);
                for (int i=0;i<5;i++) model.changed();
                assertSame("Pause and progress updates do not rebuild adaptive artwork",cover,activity.get().findViewById(R.id.current_artwork));
                assertSame(controls,activity.get().findViewById(R.id.playback_controls));
                model.playback.next();
                assertTrue("Skip displays the decoded cover in the same UI turn",hasColor(activity.get().findViewById(R.id.current_artwork),Color.GREEN));
                assertEquals("The queued artwork color applies in the same UI turn",new Appearance(context).palette(Color.GREEN).accent,playerAccent(activity.get()));
                ImageView compact = target(); Artwork.load(compact,next.url,Math.round(42 * context.getResources().getDisplayMetrics().density),true);
                assertTrue("The compact cover is also already decoded",hasColor(compact,Color.GREEN));
            });
            assertEquals("Skipping does not fetch again",1,next.hits.get());
            PandoraProtocol.Track selected=model.track; scenario.recreate(); scenario.onActivity(activity::set);
            await(() -> playerAccent(activity.get())==new Appearance(context).palette(Color.GREEN).accent);
            assertTrue(new Appearance(context).adaptive()); assertSame(selected,model.track); assertFalse(model.playing);
            NavigationLayoutTest.screenshot(context,"adaptive-green-player");
            ui(model::logout); assertFalse(model.playback != null && model.playback.artwork.ready(next.url));
        } finally { ui(model::logout); context.stopService(new Intent(context,PlaybackService.class)); }
    }
    private static int playerAccent(MainActivity activity) {
        SeekBar seek=activity.findViewById(R.id.seek_bar); return seek==null ? 0 : seek.getProgressTintList().getDefaultColor();
    }
    @Test public void adaptiveIgnoresLateCoversAndSwitchingToAFixedThemeStaysFixed() throws Exception {
        Fixture old=fixture(Color.RED,true), current=fixture(Color.GREEN,false), late=fixture(Color.BLUE,true);
        AtomicReference<AppModel> reference=new AtomicReference<>();
        ui(() -> {
            AppModel model=AppModel.get(context); model.credentials.clear(); model.signedIn=true;
            model.station=new PandoraProtocol.Station("adaptive","Adaptive artwork test",""); model.stations=Collections.singletonList(model.station);
            model.track=new PandoraProtocol.Track("old","Old song","Artist","Album","","",180,0); reference.set(model);
            // Keep an old request alive even after the screen has moved to another cover.
            Artwork.load(target(),old.url,Math.round(42*context.getResources().getDisplayMetrics().density),true);
        });
        AppModel model=reference.get();
        try (ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> activity=new AtomicReference<>(); scenario.onActivity(activity::set);
            onView(withId(R.id.nav_settings)).perform(click()); onView(withId(R.id.appearance_theme)).perform(click());
            onView(withText("Adaptive (Dynamic)")).perform(click()); assertTrue(new Appearance(context).adaptive());
            NavigationLayoutTest.screenshot(context,"adaptive-settings");
            onView(withId(R.id.nav_stations)).perform(click()); onView(withId(R.id.nav_playing)).perform(click());
            assertTrue(old.started.await(5,TimeUnit.SECONDS));
            ui(() -> { model.track=new PandoraProtocol.Track("current","Current green song","Artist","Album","",current.url,180,0); model.changed(); });
            await(() -> playerAccent(activity.get())==new Appearance(context).palette(Color.GREEN).accent);
            old.release.countDown(); await(() -> Artwork.accent(old.url)!=null);
            ui(() -> assertEquals("An old download cannot recolor the current song",new Appearance(context).palette(Color.GREEN).accent,playerAccent(activity.get())));
            ui(() -> { model.track=new PandoraProtocol.Track("missing","Song without artwork","Artist","Album","","",180,0); model.changed(); });
            ui(() -> assertEquals("Missing artwork uses the fallback instead of a previous cover",new Appearance(context).palette(null).accent,playerAccent(activity.get())));
            onView(withId(R.id.nav_stations)).perform(click()); onView(withId(R.id.nav_settings)).perform(click());
            onView(withId(R.id.appearance_theme)).perform(click()); onView(withText("Deep Ocean")).perform(click());
            ui(() -> Artwork.load(target(),late.url,120,true)); assertTrue(late.started.await(5,TimeUnit.SECONDS));
            late.release.countDown(); await(() -> Artwork.accent(late.url)!=null);
            assertEquals("ocean",new Appearance(context).theme().id); scenario.recreate();
            onView(withId(R.id.nav_stations)).perform(click()); onView(withId(R.id.nav_playing)).perform(click());
            scenario.onActivity(screen -> assertEquals("A late artwork result never changes a fixed theme",0xff7bb6ff,playerAccent(screen)));
        } finally { ui(model::logout); context.stopService(new Intent(context,PlaybackService.class)); }
    }
    @Test public void artworkSamplingIgnoresBlackWhiteAndTransparencyAndKeepsControlsReadable() {
        Bitmap sample=Bitmap.createBitmap(50,50,Bitmap.Config.ARGB_8888);
        try {
            int teal=0xff109c84; int[] pixels=new int[2500];
            java.util.Arrays.fill(pixels,0,1200,Color.WHITE); java.util.Arrays.fill(pixels,1200,2100,Color.BLACK);
            java.util.Arrays.fill(pixels,2100,2450,teal); java.util.Arrays.fill(pixels,2450,2500,Color.RED);
            sample.setPixels(pixels,0,50,0,0,50,50);
            float[] expected=new float[3], actual=new float[3]; ColorUtils.colorToHSL(teal,expected); ColorUtils.colorToHSL(Appearance.artworkAccent(sample),actual);
            assertEquals("The real artwork hue wins over its white/black border",expected[0],actual[0],1f);
            Appearance settings=new Appearance(context); settings.select(Appearance.THEMES[Appearance.THEMES.length-1]);
            for (int color:new int[]{teal,Color.BLUE,Color.RED,0xff444444,Color.YELLOW}) {
                sample.eraseColor(color); Appearance.Palette palette=settings.palette(Appearance.artworkAccent(sample));
                assertTrue("Adaptive controls keep readable contrast",ColorUtils.calculateContrast(palette.accent,palette.background)>=4.5);
            }
            for (int color:new int[]{Color.BLACK,Color.WHITE,Color.TRANSPARENT}) {
                sample.eraseColor(color); assertEquals(Appearance.ADAPTIVE_FALLBACK,Appearance.artworkAccent(sample));
            }
        } finally { sample.recycle(); }
    }
    @Test public void coverPreloadingIsBoundedAndMovesWithTheQueue() throws Exception {
        List<Fixture> covers = new ArrayList<>(); List<PandoraProtocol.Track> queue = new ArrayList<>();
        for (int i = 0; i < 8; i++) { Fixture cover = fixture(Color.BLUE,true); covers.add(cover); queue.add(new PandoraProtocol.Track("track-"+i,"Song","Artist","Album","",cover.url,180,0)); }
        Artwork.Preloader preloader = new Artwork.Preloader(context);
        try {
            ui(() -> preloader.update(queue,0)); await(() -> covers.subList(0,3).stream().allMatch(f -> f.hits.get() == 1));
            for (int i = 3; i < covers.size(); i++) assertEquals("Only current plus next two are fetched",0,covers.get(i).hits.get());
            ui(() -> preloader.update(queue,3)); await(() -> covers.subList(3,6).stream().allMatch(f -> f.hits.get() == 1));
            for (int i = 0; i < 3; i++) assertEquals("Old pending covers are cancelled",0,covers.get(i).release.getCount());
            assertEquals(0,covers.get(6).hits.get()); assertEquals(0,covers.get(7).hits.get());
        } finally { ui(preloader::clear); }
    }
}
