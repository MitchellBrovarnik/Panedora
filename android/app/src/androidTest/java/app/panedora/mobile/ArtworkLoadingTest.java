package app.panedora.mobile;

import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.drawable.BitmapDrawable;
import android.view.View;
import android.widget.ImageView;
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
}
