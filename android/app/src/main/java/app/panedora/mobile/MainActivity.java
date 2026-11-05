package app.panedora.mobile;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
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
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
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
    private static final int BG = 0xff121018, SURFACE = 0xff211c2c, BORDER = 0xff352e45;
    private static final int TEXT = 0xfff5f1fb, MUTED = 0xffaaa1bb, ACCENT = 0xffc4adff;
    private AppModel model;
    private ListenableFuture<MediaController> controllerFuture;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable observer = this::render;
    private int page;
    private final List<Integer> backStack = new ArrayList<>();
    private final int[] scrollPositions = new int[4];
    private String filter = "";
    private ScrollView scroll;
    private View currentRoot;
    private SeekBar seek;
    private TextView elapsed, remaining, selectedStationStatus;
    private ProgressBar compactProgress;
    private boolean scrubbing, loginVisible;
    private android.window.OnBackInvokedCallback backCallback;
    private EditText email, password;
    private TextView loginMessage;
    private Button loginButton, verifyButton;
    private ImageButton playControl, compactPlayControl, refreshControl;
    private View shuffleControl;
    private TextView shuffleLabel;
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
        if (saved != null) {
            page = Math.max(0,Math.min(3,saved.getInt("page",0))); filter = saved.getString("filter","");
            int[] previous = saved.getIntArray("backStack");
            if (previous != null) for (int value : previous) if (value >= 0 && value <= 3) backStack.add(value);
            int[] positions = saved.getIntArray("scrollPositions");
            if (positions != null) System.arraycopy(positions,0,scrollPositions,0,Math.min(4,positions.length));
        }
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
        if (Build.VERSION.SDK_INT >= 33 && backCallback != null) { getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback); backCallback = null; }
        if (controllerFuture != null) { MediaController.releaseFuture(controllerFuture); controllerFuture = null; }
        super.onStop();
    }
    @Override protected void onDestroy() { Artwork.clear(currentRoot); super.onDestroy(); }
    @Override protected void onSaveInstanceState(Bundle state) {
        rememberScroll(); state.putInt("page",page); state.putString("filter",filter);
        state.putIntArray("backStack",backStack.stream().mapToInt(Integer::intValue).toArray()); state.putIntArray("scrollPositions",scrollPositions);
        super.onSaveInstanceState(state);
    }
    @Override public void onBackPressed() {
        if (model.signedIn && (page != 0 || !backStack.isEmpty())) closePage(); else super.onBackPressed();
    }
    private void rememberScroll() { if (scroll != null && renderedPage >= 0 && renderedPage < 4) scrollPositions[renderedPage] = scroll.getScrollY(); }
    private void changePage(int selected) {
        if (page == selected) return;
        rememberScroll(); backStack.add(page); page = selected; scroll = null;
        View focused = getCurrentFocus();
        if (focused != null) { ((InputMethodManager)getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(focused.getWindowToken(),0); focused.clearFocus(); }
    }
    private void openPage(int selected) { changePage(selected); render(); }
    private void closePage() {
        rememberScroll(); page = backStack.isEmpty() ? 0 : backStack.remove(backStack.size()-1); scroll = null; render();
    }
    private void updateBackCallback() {
        if (Build.VERSION.SDK_INT < 33) return;
        boolean intercept = model.signedIn && (page != 0 || !backStack.isEmpty());
        if (intercept && backCallback == null) {
            backCallback = this::closePage; getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,backCallback);
        } else if (!intercept && backCallback != null) { getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback); backCallback = null; }
    }
    private final Runnable tick = new Runnable() {
        @Override public void run() {
            updateProgress();
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
    private GradientDrawable rounded(int color,int radius) {
        GradientDrawable result = new GradientDrawable(); result.setColor(color); result.setCornerRadius(dp(radius)); return result;
    }
    private ImageButton icon(int drawable,String label,boolean prominent,View.OnClickListener action) {
        ImageButton view = new ImageButton(this); view.setImageResource(drawable); view.setContentDescription(label);
        view.setImageTintList(ColorStateList.valueOf(prominent ? BG : TEXT)); view.setScaleType(ImageView.ScaleType.FIT_CENTER);
        view.setPadding(dp(prominent ? 21 : 12),dp(prominent ? 21 : 12),dp(prominent ? 21 : 12),dp(prominent ? 21 : 12));
        view.setBackground(new RippleDrawable(ColorStateList.valueOf(0x25ffffff),rounded(prominent ? ACCENT : android.graphics.Color.TRANSPARENT,40),null));
        view.setOnClickListener(action); return view;
    }
    private void toolbarIcon(LinearLayout parent,ImageButton icon) { parent.addView(icon,new LinearLayout.LayoutParams(dp(48),dp(48))); }
    private TextView singleLine(String label,int size,int color,boolean bold) {
        TextView view = text(label,size,color,bold); view.setSingleLine(true); view.setEllipsize(android.text.TextUtils.TruncateAt.END); return view;
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
    private ImageView art(String url, int size) {
        return art(url, size, false);
    }
    private ImageView art(String url, int size, boolean currentSong) {
        ImageView image = new ImageView(this); image.setScaleType(ImageView.ScaleType.CENTER_CROP);
        image.setBackground(rounded(SURFACE,size > 100 ? 20 : 10)); image.setClipToOutline(true); image.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
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
        updateBackCallback();
        if (!model.signedIn) { renderLogin(); return; }
        PandoraProtocol.Track first = model.history.isEmpty() ? null : model.history.get(0);
        if (!loginVisible && currentRoot != null && renderedPage == page && renderedTrack == model.track && renderedStation == model.station &&
            (page != 0 || renderedStations == model.stations) && renderedMessage.equals(model.message) &&
            renderedVerification == model.verification && renderedTakeover == model.takeover &&
            (page != 2 || (renderedHistorySize == model.history.size() && renderedHistoryFirst == first))) {
            updateControls(); return;
        }
        rememberScroll(); loginVisible = false; seek = null; elapsed = remaining = selectedStationStatus = shuffleLabel = null; compactProgress = null;
        playControl = compactPlayControl = refreshControl = null; shuffleControl = null; thumbControls.clear();
        int previousY = scrollPositions[page];
        LinearLayout root = root();
        if (page == 1) root.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,new int[]{0xff2d223d,0xff19131f,BG}));
        root.addView(toolbar());
        scroll = new ScrollView(this); scroll.setId(R.id.page_scroll); scroll.setFillViewport(true); scroll.setVerticalScrollBarEnabled(false);
        LinearLayout content = column(); content.setPadding(dp(24),dp(page == 1 ? 12 : 16),dp(24),dp(24)); scroll.addView(content);
        root.addView(scroll, new LinearLayout.LayoutParams(-1,0,1));
        showMessage(content);
        if (page == 0) renderStations(content); else if (page == 1) renderPlayer(content); else if (page == 2) renderHistory(content); else renderSettings(content);
        if (page != 1 && model.track != null) {
            View compact = compactPlayer(); LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1,-2);
            params.setMargins(dp(12),dp(4),dp(12),dp(10)); root.addView(compact,params);
        }
        renderedPage = page; renderedTrack = model.track; renderedStation = model.station; renderedStations = model.stations;
        renderedMessage = model.message; renderedVerification = model.verification; renderedTakeover = model.takeover;
        renderedHistorySize = model.history.size(); renderedHistoryFirst = first;
        showRoot(root);
        updateControls();
        ScrollView restored = scroll; restored.post(() -> { if (scroll == restored) restored.scrollTo(0, previousY); });
    }
    private View toolbar() {
        LinearLayout header = row(); header.setId(R.id.top_toolbar); header.setPadding(dp(12),dp(6),dp(12),dp(6)); header.setMinimumHeight(dp(64));
        if (page == 0) {
            ImageView mark = art("",28); LinearLayout.LayoutParams logo = new LinearLayout.LayoutParams(dp(28),dp(28)); logo.setMargins(dp(12),0,dp(10),0); header.addView(mark,logo);
            header.addView(text("Panedora",20,TEXT,true),new LinearLayout.LayoutParams(0,-2,1));
            ImageButton history = icon(R.drawable.ic_history,"History",false,v -> openPage(2)); history.setId(R.id.nav_history); toolbarIcon(header,history);
            ImageButton settings = icon(R.drawable.ic_settings,"Settings",false,v -> openPage(3)); settings.setId(R.id.nav_settings); toolbarIcon(header,settings);
        } else {
            ImageButton back = icon(page == 1 ? R.drawable.ic_collapse : R.drawable.ic_back,page == 1 ? "Close now playing" : "Back",false,v -> closePage());
            back.setId(R.id.nav_stations); toolbarIcon(header,back);
            if (page == 1) {
                LinearLayout copy = column(); copy.setGravity(Gravity.CENTER);
                TextView caption = text("PLAYING FROM",10,MUTED,true); caption.setLetterSpacing(.14f); copy.addView(caption);
                TextView title = singleLine(model.station == null ? "Your stations" : model.station.name,14,TEXT,true); title.setGravity(Gravity.CENTER); copy.addView(title);
                header.addView(copy,new LinearLayout.LayoutParams(0,-2,1));
                ImageButton history = icon(R.drawable.ic_history,"History",false,v -> openPage(2)); history.setId(R.id.nav_history); toolbarIcon(header,history);
            } else {
                TextView title = text(page == 2 ? "History" : "Settings",20,TEXT,true); title.setPadding(dp(8),0,0,0); header.addView(title,new LinearLayout.LayoutParams(0,-2,1));
            }
        }
        return header;
    }
    private void updateControls() {
        boolean playing = model.playback != null && model.playback.wantsPlayback();
        for (ImageButton control : new ImageButton[]{playControl,compactPlayControl}) if (control != null) {
            control.setImageResource(playing ? R.drawable.ic_pause : R.drawable.ic_play); control.setContentDescription(playing ? "Pause" : "Play"); control.setEnabled(model.station != null);
        }
        if (selectedStationStatus != null) selectedStationStatus.setText(model.loading ? "Connecting…" : playing ? "Now playing" : "Paused");
        if (refreshControl != null) { refreshControl.setContentDescription(model.busy ? "Refreshing stations" : "Refresh stations"); refreshControl.setEnabled(!model.busy); refreshControl.setAlpha(model.busy ? .4f : 1f); }
        if (shuffleControl != null) {
            shuffleControl.setEnabled(model.playback != null);
            shuffleControl.setAlpha(model.playback == null ? .5f : 1f);
            shuffleLabel.setText(model.loading && model.track == null && model.station != null && model.station.shuffle ? "Loading shuffle…" : "Shuffle Stations");
        }
        updateProgress();
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
    private void updateProgress() {
        if (model.playback == null || scrubbing) return;
        long position = model.playback.position(), duration = model.playback.duration();
        int progress = duration > 0 ? (int)Math.min(1000,position * 1000 / duration) : 0;
        if (seek != null) seek.setProgress(progress);
        if (compactProgress != null) compactProgress.setProgress(progress);
        if (elapsed != null) elapsed.setText(model.loading ? "Buffering…" : time(position));
        if (remaining != null) remaining.setText(time(duration));
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
        return icon(positive ? R.drawable.thumb_up : R.drawable.thumb_down,positive ? "Thumbs up" : "Thumbs down",false,v -> model.rateTrack(track,positive,current));
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
        seek = null; elapsed = remaining = null; compactProgress = null;
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
        LinearLayout heading = row(); heading.addView(text("Stations",32,TEXT,true),new LinearLayout.LayoutParams(0,-2,1));
        refreshControl = icon(R.drawable.ic_refresh,"Refresh stations",false,v -> model.refreshStations()); refreshControl.setId(R.id.refresh_stations); toolbarIcon(heading,refreshControl); content.addView(heading); gap(content,20);
        EditText search = field("Find a station",InputType.TYPE_CLASS_TEXT); search.setId(R.id.station_search); search.setText(filter);
        var searchIcon = getDrawable(R.drawable.ic_search); searchIcon.setTint(MUTED); searchIcon.setBounds(0,0,dp(20),dp(20)); search.setCompoundDrawablesRelative(searchIcon,null,null,null); search.setCompoundDrawablePadding(dp(12));
        search.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_DONE); content.addView(search); gap(content,20);
        LinearLayout shuffle = row(); shuffle.setId(R.id.shuffle_stations); shuffle.setMinimumHeight(dp(72)); shuffle.setPadding(dp(14),dp(12),dp(14),dp(12));
        GradientDrawable shuffleBackground = new GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT,new int[]{0xff392a50,0xff292036}); shuffleBackground.setCornerRadius(dp(16));
        shuffle.setBackground(new RippleDrawable(ColorStateList.valueOf(0x22ffffff),shuffleBackground,null));
        ImageView symbol = new ImageView(this); symbol.setImageResource(R.drawable.ic_shuffle); symbol.setImageTintList(ColorStateList.valueOf(ACCENT)); symbol.setPadding(dp(10),dp(10),dp(10),dp(10)); symbol.setBackground(rounded(0x25c4adff,12)); shuffle.addView(symbol,new LinearLayout.LayoutParams(dp(44),dp(44)));
        LinearLayout copy = column(); copy.setPadding(dp(14),0,dp(8),0); shuffleLabel = singleLine("Shuffle Stations",16,TEXT,true); copy.addView(shuffleLabel); copy.addView(text("Mix your collection",12,MUTED,false)); shuffle.addView(copy,new LinearLayout.LayoutParams(0,-2,1));
        ImageView arrow = new ImageView(this); arrow.setImageResource(R.drawable.ic_play); arrow.setImageTintList(ColorStateList.valueOf(ACCENT)); shuffle.addView(arrow,new LinearLayout.LayoutParams(dp(22),dp(22)));
        shuffle.setContentDescription("Shuffle Stations"); shuffle.setFocusable(true); shuffle.setOnClickListener(v -> {
            if (model.playback == null) return; notificationPermission(); changePage(1); model.playback.shuffle();
        }); shuffleControl = shuffle; content.addView(shuffle); gap(content,28);
        TextView label = text("YOUR STATIONS",10,MUTED,true); label.setLetterSpacing(.16f); content.addView(label); gap(content,12);
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
        list.removeAllViews(); selectedStationStatus = null; int count = 0;
        for (PandoraProtocol.Station station : model.stations) {
            if (station.shuffle) continue; // Shuffle has its permanent control above the station list.
            if (!station.name.toLowerCase(Locale.ROOT).contains(filter.toLowerCase(Locale.ROOT))) continue;
            count++;
            boolean active = model.station != null && model.station.id.equals(station.id);
            LinearLayout card = row(); card.setPadding(dp(8),dp(12),dp(10),dp(12)); card.setMinimumHeight(dp(80));
            card.setBackground(new RippleDrawable(ColorStateList.valueOf(0x18ffffff),rounded(active ? 0xff211a2d : android.graphics.Color.TRANSPARENT,14),null));
            card.addView(art(station.art,56));
            LinearLayout copy = column(); copy.setPadding(dp(16),0,dp(12),0); copy.addView(singleLine(station.name,16,TEXT,true));
            if (active) { selectedStationStatus = text("Now playing",12,ACCENT,false); copy.addView(selectedStationStatus); }
            card.addView(copy,new LinearLayout.LayoutParams(0,-2,1));
            ImageView play = new ImageView(this); play.setImageResource(R.drawable.ic_play); play.setImageTintList(ColorStateList.valueOf(active ? ACCENT : MUTED)); card.addView(play,new LinearLayout.LayoutParams(dp(20),dp(20)));
            card.setContentDescription("Play " + station.name); card.setFocusable(true);
            card.setOnClickListener(v -> {
                if (model.playback == null) { model.message = "The player is connecting. Please try again."; model.changed(); return; }
                notificationPermission(); changePage(1); model.playback.select(station);
            });
            list.addView(card,new LinearLayout.LayoutParams(-1,-2));
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
        content.setGravity(Gravity.CENTER_VERTICAL);
        int width = Artwork.playerSizeDp(this);
        ImageView cover = art(model.track == null ? "" : model.track.art,width,true); cover.setId(R.id.current_artwork);
        LinearLayout.LayoutParams coverParams = new LinearLayout.LayoutParams(dp(width),dp(width)); coverParams.gravity = Gravity.CENTER_HORIZONTAL;
        content.addView(cover,coverParams); gap(content,28);
        TextView title = text(model.track == null ? (model.loading ? "Loading your station…" : "Choose a station") : model.track.title,26,TEXT,true); title.setId(R.id.now_title); title.setMaxLines(2); title.setEllipsize(android.text.TextUtils.TruncateAt.END); content.addView(title); gap(content,6);
        TextView artist = singleLine(model.track == null ? "Your music will appear here." : model.track.artist,17,MUTED,false); content.addView(artist);
        if (model.track != null) {
            title.setContentDescription(model.track.title + ". Song details"); title.setOnClickListener(v -> showSongDetails());
            artist.setOnClickListener(v -> showSongDetails());
        }
        gap(content,22);
        seek = new SeekBar(this); seek.setId(R.id.seek_bar); seek.setMax(1000); seek.setProgressTintList(ColorStateList.valueOf(ACCENT)); seek.setThumbTintList(ColorStateList.valueOf(ACCENT)); seek.setContentDescription("Song position"); seek.setEnabled(model.track != null);
        seek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            private PandoraProtocol.Track selected;
            @Override public void onStartTrackingTouch(SeekBar bar) { scrubbing = true; selected = model.track; }
            @Override public void onProgressChanged(SeekBar bar,int value,boolean user) { if (user && model.playback != null && elapsed != null) elapsed.setText(time(model.playback.duration() * value / 1000)); }
            @Override public void onStopTrackingTouch(SeekBar bar) { if (model.playback != null && selected == model.track) model.playback.seek(model.playback.duration() * bar.getProgress() / 1000); scrubbing = false; }
        });
        content.addView(seek,new LinearLayout.LayoutParams(-1,dp(40)));
        long duration = model.playback == null ? 0 : model.playback.duration(), position = model.playback == null ? 0 : model.playback.position();
        seek.setProgress(duration > 0 ? (int)Math.min(1000,position * 1000 / duration) : 0);
        LinearLayout times = row(); times.setPadding(dp(4),0,dp(4),0); elapsed = singleLine(time(position),12,MUTED,false); remaining = singleLine(time(duration),12,MUTED,false);
        times.addView(elapsed,new LinearLayout.LayoutParams(0,-2,1)); times.addView(remaining); content.addView(times); gap(content,20);
        LinearLayout controls = row(); controls.setId(R.id.playback_controls); controls.setGravity(Gravity.CENTER);
        ImageButton down = thumbButton(model.track,false,true), up = thumbButton(model.track,true,true); down.setId(R.id.thumb_down); up.setId(R.id.thumb_up);
        ImageButton replay = icon(R.drawable.ic_replay,"Replay",false,v -> { if (model.playback != null) model.playback.seek(0); }); replay.setId(R.id.replay); replay.setEnabled(model.track != null);
        ImageButton next = icon(R.drawable.ic_next,"Next song",false,v -> { if (model.playback != null) model.playback.next(); }); next.setId(R.id.next_song); next.setEnabled(model.track != null);
        playControl = icon(R.drawable.ic_play,"Play",true,v -> { if (model.playback != null) model.playback.toggle(); }); playControl.setId(R.id.play_pause);
        for (ImageButton control : new ImageButton[]{down,replay,playControl,next,up}) {
            int size = control == playControl ? 72 : 48;
            controls.addView(control,new LinearLayout.LayoutParams(dp(size),dp(size)));
            if (control != up) controls.addView(new View(this),new LinearLayout.LayoutParams(0,1,1));
        }
        thumbControls.add(new ThumbControls(model.track,up,down)); content.addView(controls); gap(content,8);
    }
    private void showSongDetails() {
        if (model.track == null) return;
        PandoraProtocol.Track track = model.track;
        new AlertDialog.Builder(this).setTitle(track.title).setMessage(track.artist + (track.album.isEmpty() ? "" : "\n\n" + track.album) + (model.station == null ? "" : "\n\n" + model.station.name)).setPositiveButton("Done",null).show();
    }
    private View compactPlayer() {
        LinearLayout card = column(); card.setId(R.id.compact_player); card.setBackground(rounded(0xff2a2138,16)); card.setClipToOutline(true);
        LinearLayout strip = row(); strip.setId(R.id.nav_playing); strip.setPadding(dp(12),dp(10),dp(6),dp(10)); strip.setMinimumHeight(dp(68));
        ImageView cover = art(model.track.art,42,true); cover.setId(R.id.compact_artwork); strip.addView(cover);
        LinearLayout copy = column(); copy.setPadding(dp(12),0,dp(8),0);
        TextView title = text(model.track.title,14,TEXT,true); title.setMaxLines(1); title.setEllipsize(android.text.TextUtils.TruncateAt.END); copy.addView(title);
        TextView artist = singleLine(model.track.artist,12,MUTED,false); copy.addView(artist);
        strip.addView(copy,new LinearLayout.LayoutParams(0,-2,1));
        compactPlayControl = icon(R.drawable.ic_play,"Play",false,v -> { if (model.playback != null) model.playback.toggle(); }); compactPlayControl.setId(R.id.compact_play_pause); toolbarIcon(strip,compactPlayControl);
        ImageButton next = icon(R.drawable.ic_next,"Next song",false,v -> { if (model.playback != null) model.playback.next(); }); next.setId(R.id.compact_next); toolbarIcon(strip,next);
        strip.setBackground(new RippleDrawable(ColorStateList.valueOf(0x18ffffff),null,rounded(android.graphics.Color.WHITE,16)));
        strip.setContentDescription("Open now playing: " + model.track.title + ", " + model.track.artist); strip.setFocusable(true); strip.setOnClickListener(v -> openPage(1)); card.addView(strip);
        compactProgress = new ProgressBar(this,null,android.R.attr.progressBarStyleHorizontal); compactProgress.setMax(1000); compactProgress.setProgressTintList(ColorStateList.valueOf(ACCENT)); compactProgress.setProgressBackgroundTintList(ColorStateList.valueOf(0xff3e334e));
        compactProgress.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO); card.addView(compactProgress,new LinearLayout.LayoutParams(-1,dp(2))); return card;
    }
    private void renderHistory(LinearLayout content) {
        content.addView(text("Recently played",28,TEXT,true)); gap(content,8);
        content.addView(text("Your listening history from this session",14,MUTED,false)); gap(content,20);
        if (model.history.isEmpty()) { content.addView(text("Songs appear here after they finish or you skip them.",15,MUTED,false)); return; }
        for (PandoraProtocol.Track track : model.history) {
            LinearLayout card = column(); card.setPadding(dp(12),dp(12),dp(8),dp(4)); card.setBackground(rounded(SURFACE,14));
            LinearLayout song = row();
            card.setContentDescription("History: " + track.title); song.addView(art(track.art,46));
            LinearLayout copy = column(); copy.setPadding(dp(12),0,dp(4),0);
            TextView title = text(track.title,15,TEXT,true), artist = text(track.artist,12,MUTED,false);
            title.setSingleLine(true); title.setEllipsize(android.text.TextUtils.TruncateAt.END);
            artist.setSingleLine(true); artist.setEllipsize(android.text.TextUtils.TruncateAt.END); copy.addView(title); copy.addView(artist);
            for (PandoraProtocol.Station station : model.stations) if (station.id.equals(track.stationId)) {
                TextView label = text(station.name,11,MUTED,false); label.setSingleLine(true); label.setEllipsize(android.text.TextUtils.TruncateAt.END); copy.addView(label); break;
            }
            song.addView(copy,new LinearLayout.LayoutParams(0,-2,1)); card.addView(song);
            LinearLayout actions = row(); actions.setGravity(Gravity.END); actions.addView(ratingControls(track,false,48)); card.addView(actions);
            content.addView(card); gap(content,10);
        }
    }
    private void renderSettings(LinearLayout content) {
        content.addView(text("Your account",28,TEXT,true)); gap(content,20);
        LinearLayout account = column(); account.setPadding(dp(20),dp(20),dp(20),dp(20)); account.setBackground(rounded(SURFACE,18));
        account.addView(text("Connected to Pandora",17,TEXT,true)); gap(account,10); account.addView(text("Your saved sign-in stays encrypted on this phone.",14,MUTED,false)); gap(account,20);
        account.addView(button("Sign out",false,v -> { page = 0; backStack.clear(); filter = ""; for (int i=0;i<4;i++) scrollPositions[i]=0; scroll = null; model.logout(); })); content.addView(account); gap(content,32);
        content.addView(text("Playback",18,TEXT,true)); gap(content,10);
        content.addView(text("Use your phone’s volume buttons for volume. Keep listening with your screen locked, and control music from the lock screen or notification.",15,MUTED,false)); gap(content,32);
        content.addView(text("Panedora for Android",18,TEXT,true)); gap(content,8); content.addView(text(BuildConfig.VERSION_NAME,14,MUTED,false));
    }
}
