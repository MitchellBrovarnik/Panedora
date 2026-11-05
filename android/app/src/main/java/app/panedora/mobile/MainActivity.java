package app.panedora.mobile;

import android.Manifest;
import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.TextView;
import androidx.core.content.ContextCompat;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;
import com.google.common.util.concurrent.ListenableFuture;
import java.util.Locale;
import java.util.ArrayList;
import java.util.List;

@UnstableApi
public final class MainActivity extends Activity {
    private static final int BG = 0xff101016, SURFACE = 0xff1b1a26, BORDER = 0xff302d43;
    private static final int TEXT = 0xffeeedf3, MUTED = 0xffa8a5ba, ACCENT = 0xffb4a8f0;
    private AppModel model;
    private ListenableFuture<MediaController> controllerFuture;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable observer = this::render;
    private int page;
    private String filter = "";
    private ScrollView scroll;
    private View currentRoot;
    private SeekBar seek;
    private TextView elapsed;
    private boolean scrubbing, loginVisible;
    private EditText email, password;
    private TextView loginMessage;
    private Button loginButton, verifyButton;
    private Button playControl, compactPlayControl, refreshControl;
    private final List<ThumbControls> thumbControls = new ArrayList<>();
    private int renderedPage = -1, renderedHistorySize;
    private PandoraProtocol.Track renderedTrack, renderedHistoryFirst;
    private PandoraProtocol.Station renderedStation;
    private List<PandoraProtocol.Station> renderedStations;
    private String renderedMessage = "";
    private PandoraClient.ApiException renderedVerification;
    private boolean renderedTakeover;
    private static final class ThumbControls {
        final PandoraProtocol.Track track; final ImageButton up, down;
        ThumbControls(PandoraProtocol.Track track,ImageButton up,ImageButton down) { this.track = track; this.up = up; this.down = down; }
    }

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved); WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        setVolumeControlStream(android.media.AudioManager.STREAM_MUSIC);
        model = AppModel.get(this);
        if (saved != null) { page = saved.getInt("page", 0); filter = saved.getString("filter", ""); }
        render();
    }
    @Override protected void onStart() {
        super.onStart(); model.listeners.add(observer); model.restore();
        controllerFuture = new MediaController.Builder(this, new SessionToken(this, new ComponentName(this, PlaybackService.class))).buildAsync();
        ListenableFuture<MediaController> future = controllerFuture;
        future.addListener(() -> {
            if (controllerFuture != future) return;
            try { future.get(); render(); }
            catch (Exception e) { model.message = "The Android player could not start. Close and reopen Panedora."; render(); }
        }, ContextCompat.getMainExecutor(this));
        render(); handler.post(tick);
    }
    @Override protected void onStop() {
        model.listeners.remove(observer); handler.removeCallbacks(tick);
        if (controllerFuture != null) { MediaController.releaseFuture(controllerFuture); controllerFuture = null; }
        super.onStop();
    }
    @Override protected void onDestroy() { Artwork.clear(currentRoot); super.onDestroy(); }
    @Override protected void onSaveInstanceState(Bundle state) { state.putInt("page", page); state.putString("filter", filter); super.onSaveInstanceState(state); }
    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (seek != null && model.playback != null && !scrubbing) {
                long duration = model.playback.duration(), position = model.playback.position();
                seek.setProgress(duration > 0 ? (int) Math.min(1000, position * 1000 / duration) : 0);
                if (elapsed != null) elapsed.setText(model.loading ? "Buffering…" : time(position) + "  /  " + time(duration));
            }
            handler.postDelayed(this, 500);
        }
    };
    private int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private static String time(long millis) { long seconds = Math.max(0, millis / 1000); return String.format(Locale.US, "%d:%02d", seconds / 60, seconds % 60); }
    private LinearLayout column() { LinearLayout view = new LinearLayout(this); view.setOrientation(LinearLayout.VERTICAL); return view; }
    private LinearLayout row() { LinearLayout view = new LinearLayout(this); view.setGravity(Gravity.CENTER_VERTICAL); return view; }
    private GradientDrawable shape(int color, int radius) {
        GradientDrawable result = new GradientDrawable(); result.setColor(color); result.setCornerRadius(dp(radius)); result.setStroke(dp(1), BORDER); return result;
    }
    private TextView text(String value, int size, int color, boolean bold) {
        TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(color);
        if (bold) view.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        view.setLineSpacing(dp(2), 1); return view;
    }
    private Button button(String label, boolean filled, View.OnClickListener action) {
        Button view = new Button(this); view.setText(label); view.setTextSize(14); view.setAllCaps(false);
        view.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); view.setTextColor(filled ? BG : TEXT);
        view.setMinHeight(dp(48)); view.setMinimumHeight(dp(48)); view.setPadding(dp(12), dp(4), dp(12), dp(4));
        view.setBackgroundTintList(null); view.setBackground(new RippleDrawable(ColorStateList.valueOf(0x22ffffff), shape(filled ? ACCENT : SURFACE, 12), null));
        view.setOnClickListener(action); return view;
    }
    private void gap(LinearLayout parent, int height) { View gap = new View(this); parent.addView(gap, new LinearLayout.LayoutParams(1, dp(height))); }
    private LinearLayout.LayoutParams weighted() { LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(50), 1); params.setMargins(dp(4), 0, dp(4), 0); return params; }
    private ImageView art(String url, int size) {
        return art(url, size, false);
    }
    private ImageView art(String url, int size, boolean currentSong) {
        ImageView image = new ImageView(this); image.setScaleType(ImageView.ScaleType.CENTER_CROP);
        image.setBackground(shape(SURFACE, 14)); image.setClipToOutline(true); image.setContentDescription("Artwork");
        image.setLayoutParams(new LinearLayout.LayoutParams(dp(size), dp(size))); Artwork.load(image, url, dp(size), currentSong); return image;
    }
    private void showRoot(View root) {
        View previous = currentRoot; currentRoot = root;
        setContentView(root); ViewCompat.requestApplyInsets(root);
        // Start replacement requests first so matching in-flight loads are shared.
        Artwork.clear(previous);
    }
    private LinearLayout root() {
        LinearLayout root = column(); root.setBackgroundColor(BG);
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            var padding = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.ime());
            view.setPadding(padding.left, padding.top, padding.right, padding.bottom); return insets;
        });
        return root;
    }
    private void render() {
        if (isFinishing()) return;
        if (!model.signedIn) { renderLogin(); return; }
        PandoraProtocol.Track first = model.history.isEmpty() ? null : model.history.get(0);
        if (!loginVisible && currentRoot != null && renderedPage == page && renderedTrack == model.track && renderedStation == model.station &&
            (page != 0 || renderedStations == model.stations) && renderedMessage.equals(model.message) &&
            renderedVerification == model.verification && renderedTakeover == model.takeover &&
            (page != 2 || (renderedHistorySize == model.history.size() && renderedHistoryFirst == first))) {
            updateControls(); return;
        }
        loginVisible = false; seek = null; elapsed = null;
        playControl = compactPlayControl = refreshControl = null; thumbControls.clear();
        int previousY = scroll == null ? 0 : scroll.getScrollY();
        LinearLayout root = root(), header = row(); header.setPadding(dp(20), dp(14), dp(20), dp(12));
        ImageView mark = art("", 32); header.addView(mark);
        TextView title = text("Panedora", 23, TEXT, true); title.setPadding(dp(10),0,0,0); title.setSingleLine(true); title.setEllipsize(android.text.TextUtils.TruncateAt.END); header.addView(title, new LinearLayout.LayoutParams(0,-2,1));
        TextView tag = text("ANDROID PREVIEW", 10, MUTED, true); tag.setLetterSpacing(.08f); tag.setPadding(dp(8),0,0,0); header.addView(tag); root.addView(header);
        scroll = new ScrollView(this); scroll.setId(R.id.page_scroll); scroll.setFillViewport(true);
        LinearLayout content = column(); content.setPadding(dp(20), dp(12), dp(20), dp(20)); scroll.addView(content);
        root.addView(scroll, new LinearLayout.LayoutParams(-1,0,1));
        showMessage(content);
        if (page == 0) renderStations(content); else if (page == 1) renderPlayer(content); else if (page == 2) renderHistory(content); else renderSettings(content);
        if (page != 1 && model.track != null) root.addView(compactPlayer());
        LinearLayout nav = row(); nav.setPadding(dp(12), dp(10), dp(12), dp(12));
        String[] labels = {"Stations", "Playing", "History", "Settings"};
        int[] ids = {R.id.nav_stations,R.id.nav_playing,R.id.nav_history,R.id.nav_settings};
        for (int i = 0; i < labels.length; i++) {
            int selected = i; Button item = button(labels[i], page == i, v -> { page = selected; scroll = null; render(); });
            item.setId(ids[i]); item.setTextSize(12); nav.addView(item, weighted());
        }
        renderedPage = page; renderedTrack = model.track; renderedStation = model.station; renderedStations = model.stations;
        renderedMessage = model.message; renderedVerification = model.verification; renderedTakeover = model.takeover;
        renderedHistorySize = model.history.size(); renderedHistoryFirst = first;
        root.addView(nav); showRoot(root);
        updateControls();
        ScrollView restored = scroll; restored.post(() -> { if (scroll == restored) restored.scrollTo(0, previousY); });
    }
    private void updateControls() {
        boolean playing = model.playback != null && model.playback.wantsPlayback();
        if (playControl != null) { playControl.setText(playing ? "Pause" : "Play"); playControl.setEnabled(model.station != null); }
        if (compactPlayControl != null) compactPlayControl.setText(playing ? "Pause" : "Play");
        if (refreshControl != null) { refreshControl.setText(model.busy ? "Loading…" : "Refresh"); refreshControl.setEnabled(!model.busy); }
        if (elapsed != null && model.playback != null && !scrubbing) elapsed.setText(model.loading ? "Buffering…" : time(model.playback.position()) + "  /  " + time(model.playback.duration()));
        for (ThumbControls controls : thumbControls) {
            boolean enabled = controls.track != null && !model.feedbackBusy;
            controls.up.setEnabled(enabled); controls.down.setEnabled(enabled);
            int rating = controls.track == null ? 0 : controls.track.rating;
            controls.up.setImageTintList(ColorStateList.valueOf(rating == 1 ? 0xff7dd3a5 : MUTED));
            controls.down.setImageTintList(ColorStateList.valueOf(rating == -1 ? 0xfff09a9a : MUTED));
            controls.up.setSelected(rating == 1); controls.down.setSelected(rating == -1);
            controls.up.setContentDescription(rating == 1 ? "Undo thumbs up" : "Thumbs up");
            controls.down.setContentDescription(rating == -1 ? "Undo thumbs down" : "Thumbs down");
            controls.up.setAlpha(enabled ? 1f : .45f); controls.down.setAlpha(enabled ? 1f : .45f);
        }
    }
    private View ratingControls(PandoraProtocol.Track track, boolean current, int size) {
        LinearLayout row = row(); row.setGravity(Gravity.CENTER);
        ImageButton down = thumbButton(track,false,current), up = thumbButton(track,true,current);
        if (current) { down.setId(R.id.thumb_down); up.setId(R.id.thumb_up); }
        for (ImageButton button : new ImageButton[]{down,up}) {
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(dp(size),dp(size)); params.setMargins(dp(4),0,dp(4),0); row.addView(button,params);
        }
        thumbControls.add(new ThumbControls(track,up,down)); return row;
    }
    private ImageButton thumbButton(PandoraProtocol.Track track, boolean positive, boolean current) {
        ImageButton button = new ImageButton(this); button.setImageResource(positive ? R.drawable.thumb_up : R.drawable.thumb_down);
        button.setPadding(dp(12),dp(12),dp(12),dp(12));
        button.setBackground(new RippleDrawable(ColorStateList.valueOf(0x22ffffff),shape(SURFACE,12),null));
        button.setOnClickListener(v -> model.rateTrack(track,positive,current)); return button;
    }
    private void showMessage(LinearLayout content) {
        if (model.message.isEmpty()) return;
        LinearLayout notice = column(); notice.setBackground(shape(SURFACE, 12)); notice.setPadding(dp(14),dp(12),dp(14),dp(12));
        notice.addView(text(model.message, 14, TEXT, false)); gap(notice, 10);
        if (model.verification != null) notice.addView(button("Verify with Pandora", true, v -> startActivity(new Intent(this, VerificationActivity.class))));
        else if (model.takeover) {
            notice.addView(button("Play here instead", true, v -> { if (model.playback != null) model.playback.resume(true); })); gap(notice,8);
            notice.addView(button("Keep the other device playing", false, v -> { model.takeover = false; model.message = ""; model.changed(); }));
        } else notice.addView(button("Dismiss", false, v -> { model.message = ""; model.changed(); }));
        content.addView(notice); gap(content,16);
    }
    private void renderLogin() {
        seek = null; elapsed = null;
        if (!loginVisible) {
            loginVisible = true;
            LinearLayout root = root(); ScrollView holder = new ScrollView(this); holder.setFillViewport(true);
            LinearLayout form = column(); form.setGravity(Gravity.CENTER_VERTICAL); form.setPadding(dp(28),dp(28),dp(28),dp(32));
            ImageView mark = art("",72); form.addView(mark); gap(form,24);
            form.addView(text("Your stations.\nA little closer.",32,TEXT,true)); gap(form,12);
            form.addView(text("Sign in to Pandora to try Panedora on your phone.",16,MUTED,false)); gap(form,28);
            email = field("Pandora email", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS); email.setId(R.id.login_email); email.setAutofillHints(View.AUTOFILL_HINT_EMAIL_ADDRESS); form.addView(email); gap(form,12);
            password = field("Password", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD); password.setId(R.id.login_password); password.setSaveEnabled(false); password.setAutofillHints(View.AUTOFILL_HINT_PASSWORD); form.addView(password); gap(form,16);
            loginButton = button("Sign in", true, v -> model.login(email.getText().toString(), password.getText().toString())); loginButton.setId(R.id.login_button); form.addView(loginButton);
            gap(form,14); loginMessage = text("",14,0xfff0b7b7,false); loginMessage.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); form.addView(loginMessage);
            verifyButton = button("Verify with Pandora", false, v -> startActivity(new Intent(this, VerificationActivity.class))); form.addView(verifyButton); gap(form,20);
            form.addView(text("Requires Pandora Plus or Premium.\nYour sign-in stays encrypted on this phone.",13,MUTED,false)); gap(form,16);
            form.addView(text("Android prototype · " + BuildConfig.VERSION_NAME,12,MUTED,false));
            holder.addView(form); root.addView(holder,new LinearLayout.LayoutParams(-1,-1)); showRoot(root);
        }
        loginButton.setEnabled(!model.busy); loginButton.setText(model.busy ? "Signing in…" : "Sign in");
        email.setEnabled(!model.busy); password.setEnabled(!model.busy);
        loginMessage.setText(model.message); loginMessage.setVisibility(model.message.isEmpty() ? View.GONE : View.VISIBLE);
        verifyButton.setVisibility(model.verification == null ? View.GONE : View.VISIBLE);
    }
    private EditText field(String hint, int type) {
        EditText view = new EditText(this); view.setHint(hint); view.setTextColor(TEXT); view.setHintTextColor(MUTED); view.setTextSize(16);
        view.setSingleLine(true); view.setInputType(type); view.setPadding(dp(16),dp(15),dp(16),dp(15)); view.setBackground(shape(SURFACE,12)); return view;
    }
    private void renderStations(LinearLayout content) {
        LinearLayout heading = row(); heading.addView(text("Your stations",27,TEXT,true),new LinearLayout.LayoutParams(0,-2,1));
        Button refresh = button(model.busy ? "Loading…" : "Refresh", false, v -> model.refreshStations()); refreshControl = refresh; refresh.setEnabled(!model.busy); heading.addView(refresh); content.addView(heading); gap(content,8);
        content.addView(text("Pick a station and settle in.",14,MUTED,false)); gap(content,20);
        EditText search = field("Find a station",InputType.TYPE_CLASS_TEXT); search.setText(filter); content.addView(search); gap(content,18);
        LinearLayout list = column(); list.setId(R.id.station_list); content.addView(list);
        populateStations(list);
        search.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s,int start,int count,int after) {}
            @Override public void onTextChanged(CharSequence s,int start,int before,int count) { filter = s.toString(); populateStations(list); }
            @Override public void afterTextChanged(Editable value) {}
        });
    }
    private void populateStations(LinearLayout list) {
        var previous = new ArrayList<View>();
        for (int i = 0; i < list.getChildCount(); i++) previous.add(list.getChildAt(i));
        list.removeAllViews(); int count = 0;
        for (PandoraProtocol.Station station : model.stations) {
            if (!station.name.toLowerCase(Locale.ROOT).contains(filter.toLowerCase(Locale.ROOT))) continue;
            count++;
            LinearLayout card = row(); card.setPadding(dp(12),dp(12),dp(12),dp(12)); card.setBackground(new RippleDrawable(ColorStateList.valueOf(0x22ffffff),shape(SURFACE,14),null));
            card.addView(art(station.art,54));
            LinearLayout copy = column(); copy.setPadding(dp(14),0,dp(8),0);
            copy.addView(text(station.name,16,TEXT,true));
            boolean active = model.station != null && model.station.id.equals(station.id);
            copy.addView(text(active ? "Selected station" : "Pandora station",12,active ? ACCENT : MUTED,false));
            card.addView(copy,new LinearLayout.LayoutParams(0,-2,1)); card.addView(text("›",26,MUTED,false));
            card.setContentDescription("Play " + station.name); card.setFocusable(true);
            card.setOnClickListener(v -> {
                if (model.playback == null) { model.message = "The player is connecting. Please try again."; model.changed(); return; }
                notificationPermission(); page = 1; scroll = null; model.playback.select(station);
            });
            list.addView(card,new LinearLayout.LayoutParams(-1,-2)); gap(list,10);
        }
        if (count == 0) list.addView(text(model.stations.isEmpty() ? "No stations yet. Add one in Pandora, then tap Refresh." : "No stations match your search.",15,MUTED,false));
        for (View removed : previous) Artwork.clear(removed);
    }
    private void notificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED && !getPreferences(MODE_PRIVATE).getBoolean("notificationsAsked",false)) {
            getPreferences(MODE_PRIVATE).edit().putBoolean("notificationsAsked",true).apply();
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
    }
    private void renderPlayer(LinearLayout content) {
        content.addView(text(model.station == null ? "Now Playing" : model.station.name,15,ACCENT,true)); gap(content,22);
        var metrics = getResources().getDisplayMetrics();
        // Leave room for the song information, touch controls, navigation, and system bars.
        // Short windows can still scroll; ordinary portrait phones keep the thumbs visible.
        int width = Math.max(160, Math.min(320, Math.min(Math.round(metrics.widthPixels / metrics.density) - 48, Math.round(metrics.heightPixels / metrics.density) - 620)));
        ImageView cover = art(model.track == null ? "" : model.track.art,width,true); cover.setId(R.id.current_artwork);
        LinearLayout.LayoutParams coverParams = new LinearLayout.LayoutParams(dp(width),dp(width)); coverParams.gravity = Gravity.CENTER_HORIZONTAL;
        content.addView(cover,coverParams); gap(content,24);
        TextView title = text(model.track == null ? (model.loading ? "Loading your station…" : "Choose a station") : model.track.title,26,TEXT,true); title.setId(R.id.now_title); content.addView(title); gap(content,7);
        content.addView(text(model.track == null ? "Your music will appear here." : model.track.artist,17,MUTED,false)); gap(content,6);
        if (model.track != null && !model.track.album.isEmpty()) content.addView(text(model.track.album,13,MUTED,false));
        gap(content,24);
        seek = new SeekBar(this); seek.setId(R.id.seek_bar); seek.setMax(1000); seek.setProgressTintList(ColorStateList.valueOf(ACCENT)); seek.setThumbTintList(ColorStateList.valueOf(ACCENT)); seek.setContentDescription("Song position"); seek.setEnabled(model.track != null);
        seek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            private PandoraProtocol.Track selected;
            @Override public void onStartTrackingTouch(SeekBar bar) { scrubbing = true; selected = model.track; }
            @Override public void onProgressChanged(SeekBar bar,int value,boolean user) { if (user && model.playback != null && elapsed != null) elapsed.setText(time(model.playback.duration() * value / 1000) + "  /  " + time(model.playback.duration())); }
            @Override public void onStopTrackingTouch(SeekBar bar) { if (model.playback != null && selected == model.track) model.playback.seek(model.playback.duration() * bar.getProgress() / 1000); scrubbing = false; }
        });
        content.addView(seek,new LinearLayout.LayoutParams(-1,dp(48)));
        long duration = model.playback == null ? 0 : model.playback.duration(), position = model.playback == null ? 0 : model.playback.position();
        seek.setProgress(duration > 0 ? (int)Math.min(1000,position * 1000 / duration) : 0);
        elapsed = text(time(position) + "  /  " + time(duration),12,MUTED,false); elapsed.setSingleLine(true); content.addView(elapsed); gap(content,16);
        LinearLayout controls = row();
        Button replay = button("Replay",false,v -> { if (model.playback != null) model.playback.seek(0); }); replay.setEnabled(model.track != null); controls.addView(replay,weighted());
        Button play = button("Play",true,v -> { if (model.playback != null) model.playback.toggle(); }); playControl = play; play.setId(R.id.play_pause); play.setEnabled(model.station != null); controls.addView(play,weighted());
        Button next = button("Next",false,v -> { if (model.playback != null) model.playback.next(); }); next.setEnabled(model.track != null); controls.addView(next,weighted()); content.addView(controls); gap(content,14);
        content.addView(ratingControls(model.track,true,52));
    }
    private View compactPlayer() {
        LinearLayout strip = row(); strip.setBackground(shape(SURFACE,14)); strip.setPadding(dp(14),dp(10),dp(14),dp(10));
        ImageView cover = art(model.track.art,42,true); cover.setId(R.id.compact_artwork); strip.addView(cover);
        LinearLayout copy = column(); copy.setPadding(dp(12),0,dp(8),0);
        TextView title = text(model.track.title,14,TEXT,true); title.setMaxLines(1); title.setEllipsize(android.text.TextUtils.TruncateAt.END); copy.addView(title);
        TextView artist = text(model.track.artist,12,MUTED,false); artist.setMaxLines(1); copy.addView(artist);
        strip.addView(copy,new LinearLayout.LayoutParams(0,-2,1));
        compactPlayControl = button("Play",true,v -> { if (model.playback != null) model.playback.toggle(); }); strip.addView(compactPlayControl);
        strip.setOnClickListener(v -> { page = 1; scroll = null; render(); }); return strip;
    }
    private void renderHistory(LinearLayout content) {
        content.addView(text("Recently played",27,TEXT,true)); gap(content,8);
        content.addView(text("This session · most recent first",14,MUTED,false)); gap(content,20);
        if (model.history.isEmpty()) { content.addView(text("Songs appear here after they finish or you skip them.",15,MUTED,false)); return; }
        for (PandoraProtocol.Track track : model.history) {
            LinearLayout card = row(); card.setPadding(dp(10),dp(10),dp(6),dp(10)); card.setBackground(shape(SURFACE,14));
            card.setContentDescription("History: " + track.title); card.addView(art(track.art,46));
            LinearLayout copy = column(); copy.setPadding(dp(12),0,dp(4),0);
            TextView title = text(track.title,15,TEXT,true), artist = text(track.artist,12,MUTED,false);
            title.setSingleLine(true); title.setEllipsize(android.text.TextUtils.TruncateAt.END);
            artist.setSingleLine(true); artist.setEllipsize(android.text.TextUtils.TruncateAt.END); copy.addView(title); copy.addView(artist);
            for (PandoraProtocol.Station station : model.stations) if (station.id.equals(track.stationId)) {
                TextView label = text(station.name,11,MUTED,false); label.setSingleLine(true); label.setEllipsize(android.text.TextUtils.TruncateAt.END); copy.addView(label); break;
            }
            card.addView(copy,new LinearLayout.LayoutParams(0,-2,1)); card.addView(ratingControls(track,false,48));
            content.addView(card); gap(content,10);
        }
    }
    private void renderSettings(LinearLayout content) {
        content.addView(text("Settings",27,TEXT,true)); gap(content,24);
        content.addView(text("Made for your phone",18,TEXT,true)); gap(content,10);
        content.addView(text("Use your phone’s volume buttons to adjust playback. Music is handled by Android’s background player, with controls on the lock screen and notification panel.",15,MUTED,false)); gap(content,26);
        content.addView(text("Your account stays with you",18,TEXT,true)); gap(content,10);
        content.addView(text("Your phone connects directly to Pandora. Saved sign-in details are encrypted on this device. Signing out removes them.",15,MUTED,false)); gap(content,20);
        content.addView(button("Sign out",false,v -> { page = 0; filter = ""; model.logout(); })); gap(content,30);
        content.addView(text("Panedora for Android",18,TEXT,true)); gap(content,8);
        content.addView(text(BuildConfig.VERSION_NAME + "\nThis early build focuses on stations, playback, and thumbs. Themes, effects, lyrics, and station tuning are not included yet.",14,MUTED,false));
    }
}
