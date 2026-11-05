package app.panedora.mobile;

import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.widget.SeekBar;
import androidx.media3.common.util.UnstableApi;
import androidx.test.core.app.ActivityScenario;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.action.ViewActions.click;
import static androidx.test.espresso.action.ViewActions.closeSoftKeyboard;
import static androidx.test.espresso.action.ViewActions.replaceText;
import static androidx.test.espresso.assertion.ViewAssertions.matches;
import static androidx.test.espresso.matcher.ViewMatchers.*;
import static org.junit.Assert.*;

@UnstableApi
@RunWith(AndroidJUnit4.class)
public class AppearanceNotificationTest {
    private final Context context=ApplicationProvider.getApplicationContext();
    private AppModel model;
    private static void ui(Runnable task) { InstrumentationRegistry.getInstrumentation().runOnMainSync(task); }
    private static void await(BooleanSupplier condition) throws Exception {
        long deadline=System.currentTimeMillis()+15000;
        while (System.currentTimeMillis()<deadline) {
            AtomicReference<Boolean> result=new AtomicReference<>(); ui(() -> result.set(condition.getAsBoolean()));
            if (Boolean.TRUE.equals(result.get())) return; Thread.sleep(50);
        }
        AtomicReference<String> state=new AtomicReference<>("");
        ui(() -> {
            AppModel model=AppModel.get(ApplicationProvider.getApplicationContext());
            try {
                var field=PlaybackService.class.getDeclaredField("player"); field.setAccessible(true);
                var player=(androidx.media3.common.Player)field.get(model.playback);
                state.set(" playerState="+player.getPlaybackState()+" ready="+player.getPlayWhenReady()+" suppression="+player.getPlaybackSuppressionReason()+" error="+player.getPlayerError()+" message="+model.message);
            } catch (Exception error) { state.set(" playback="+model.playback+" message="+model.message); }
        });
        fail("Appearance or notification did not reach the expected state"+state.get());
    }
    @Before public void prepare() throws Exception { context.getSharedPreferences("appearance",Context.MODE_PRIVATE).edit().clear().commit(); model=NavigationLayoutTest.prepare(context); }
    @After public void stop() throws Exception {
        if (model!=null) { ui(model::logout); context.stopService(new Intent(context,PlaybackService.class)); CountDownLatch drained=new CountDownLatch(1); model.io.execute(drained::countDown); assertTrue(drained.await(5,TimeUnit.SECONDS)); }
        context.getSharedPreferences("appearance",Context.MODE_PRIVATE).edit().clear().commit();
    }
    private void start() throws Exception {
        await(() -> model.playback!=null); onView(withContentDescription("Play Night Drive Radio")).perform(click()); await(() -> model.playing && model.track!=null);
    }
    private PendingIntent notificationTap() {
        for (var entry:context.getSystemService(NotificationManager.class).getActiveNotifications()) if (entry.getNotification().contentIntent!=null) return entry.getNotification().contentIntent;
        return null;
    }
    @Test public void themesAndCustomAccentPersistWithoutRestartingPlayback() throws Exception {
        try (ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            start(); PandoraProtocol.Track original=model.track;
            onView(withId(R.id.nav_stations)).perform(click()); onView(withId(R.id.nav_settings)).perform(click());
            onView(withId(R.id.appearance_theme)).perform(click()); onView(withText("Deep Ocean")).perform(click());
            assertEquals("ocean",new Appearance(context).theme().id); NavigationLayoutTest.screenshot(context,"theme-settings");
            onView(withId(R.id.appearance_accent)).perform(click()); onView(withText("Custom hex…")).perform(click());
            onView(withId(R.id.custom_accent)).perform(replaceText("#12"),closeSoftKeyboard()); onView(withText("Apply")).perform(click());
            onView(withId(R.id.custom_accent)).check(matches(hasErrorText("Use six hex digits, for example #7BB6FF.")));
            onView(withId(R.id.custom_accent)).perform(replaceText("#FFCC00"),closeSoftKeyboard()); onView(withText("Apply")).perform(click());
            assertEquals(0xffffcc00,new Appearance(context).accent()); scenario.recreate();
            assertEquals("ocean",new Appearance(context).theme().id); assertEquals(0xffffcc00,new Appearance(context).accent()); assertSame(original,model.track); assertTrue(model.playing);
            onView(withId(R.id.nav_stations)).perform(click()); onView(withId(R.id.nav_playing)).perform(click());
            scenario.onActivity(activity -> assertEquals(0xffffcc00,((SeekBar)activity.findViewById(R.id.seek_bar)).getProgressTintList().getDefaultColor()));
            NavigationLayoutTest.screenshot(context,"custom-accent-player");
        }
    }
    @Test public void notificationTapUsesTheCurrentStationForExistingAndNewActivities() throws Exception {
        PendingIntent tap; PandoraProtocol.Track current;
        try (ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            start(); await(() -> notificationTap()!=null); tap=notificationTap();
            AtomicReference<MainActivity> activity=new AtomicReference<>(); scenario.onActivity(activity::set);
            onView(withId(R.id.nav_stations)).perform(click()); onView(withId(R.id.nav_settings)).perform(click());
            current=model.track; PandoraProtocol.Track original=current; AtomicReference<Long> position=new AtomicReference<>(); ui(() -> position.set(model.playback.position())); tap.send();
            await(() -> activity.get().findViewById(R.id.current_artwork)!=null);
            ui(() -> { assertSame("A notification never reloads the station",original,model.track); assertTrue(model.playback.position()>=position.get()); });
            PandoraProtocol.Track initial=current; ui(() -> model.playback.select(model.stations.get(1))); await(() -> model.playing && model.track!=initial);
            PandoraProtocol.Track newer=model.track;
            onView(withId(R.id.nav_stations)).perform(click()); onView(withId(R.id.nav_settings)).perform(click()); tap.send();
            await(() -> activity.get().findViewById(R.id.current_artwork)!=null); assertSame(newer,model.track); assertEquals("station-1",model.station.id);
            onView(withId(R.id.nav_stations)).perform(click()); onView(withId(R.id.nav_settings)).perform(click()); scenario.recreate();
            onView(withId(R.id.appearance_theme)).check(matches(isDisplayed())); current=model.track;
        }
        assertNotNull("Destroying the screen leaves the active service",model.playback);
        try (ActivityScenario<MainActivity> reopened=ActivityScenario.launch(MainActivity.nowPlayingIntent(context).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))) {
            onView(withId(R.id.current_artwork)).check(matches(isDisplayed())); await(() -> model.playing);
            assertSame(current,model.track); ui(() -> assertTrue(model.playback.wantsPlayback()));
            NavigationLayoutTest.screenshot(context,"notification-player");
        }
    }
    @Test public void notificationWithoutAnActiveStationFallsBackWithoutStartingMusic() throws Exception {
        try (ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.nowPlayingIntent(context).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))) {
            await(() -> model.playback!=null); onView(withId(R.id.station_list)).check(matches(isDisplayed()));
            ui(() -> { assertNull(model.track); assertNull(model.station); assertFalse(model.playback.wantsPlayback()); });
        }
    }
}
