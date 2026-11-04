package app.panedora.mobile;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Process lifetime state; playback belongs to the service, never to an Activity. */
@androidx.media3.common.util.UnstableApi
final class AppModel {
    private static AppModel instance;
    static synchronized AppModel get(Context context) {
        if (instance == null) instance = new AppModel(context.getApplicationContext());
        return instance;
    }
    final Handler main = new Handler(Looper.getMainLooper());
    final ExecutorService io = Executors.newSingleThreadExecutor();
    final CredentialStore credentials;
    PandoraGateway api;
    PlaybackService playback;
    final List<Runnable> listeners = new CopyOnWriteArrayList<>();
    List<PandoraProtocol.Station> stations = new ArrayList<>();
    final List<PandoraProtocol.Track> history = new ArrayList<>();
    PandoraProtocol.Station station;
    PandoraProtocol.Track track;
    boolean signedIn, busy, playing, loading, feedbackBusy, takeover;
    String message = "";
    PandoraClient.ApiException verification;
    private Runnable verificationRetry;
    private volatile int authGeneration;
    private boolean restoreAttempted;
    private AppModel(Context context) { credentials = new CredentialStore(context); api = new PandoraClient(context, credentials); }
    void changed() { for (Runnable listener : listeners) listener.run(); }
    void restore() {
        if (restoreAttempted || signedIn) return; restoreAttempted = true;
        int generation = authGeneration;
        io.execute(() -> {
            JSONObject saved = credentials.read();
            main.post(() -> { if (generation == authGeneration && saved != null) login(saved.optString("email"), saved.optString("password")); });
        });
    }
    void login(String email, String password) {
        if (busy) return;
        if (email.trim().isEmpty() || password.isEmpty()) { message = "Enter your Pandora email and password."; changed(); return; }
        int generation = ++authGeneration;
        busy = true; message = ""; verification = null; changed();
        io.execute(() -> {
            try {
                api.login(email.trim(), password);
                if (generation != authGeneration) return;
                credentials.save(email.trim(), password);
                List<PandoraProtocol.Station> result = api.stations();
                main.post(() -> {
                    if (generation != authGeneration) return;
                    busy = false; signedIn = true; stations = result; message = ""; verificationRetry = null; changed();
                });
            } catch (Exception e) {
                main.post(() -> { if (generation == authGeneration) { busy = false; fail(e, () -> login(email, password)); } });
            }
        });
    }
    void refreshStations() {
        if (busy) return; busy = true; message = ""; changed(); int generation = authGeneration;
        io.execute(() -> {
            try {
                List<PandoraProtocol.Station> result = api.stations();
                main.post(() -> { if (generation == authGeneration) { stations = result; busy = false; changed(); } });
            } catch (Exception e) { main.post(() -> { if (generation == authGeneration) { busy = false; fail(e, this::refreshStations); } }); }
        });
    }
    void fail(Exception exception, Runnable retry) {
        message = exception.getMessage() == null ? "Could not connect to Pandora. Please try again." : exception.getMessage();
        if (exception instanceof PandoraClient.ApiException e) {
            if (e.verification()) { verification = e; verificationRetry = retry; }
            if (e.conflict()) takeover = true;
            if (e.expired()) { signedIn = false; if (playback != null) playback.clearPlayback(); }
        }
        changed();
    }
    void verified() {
        Runnable retry = verificationRetry; verificationRetry = null; verification = null; message = ""; changed();
        if (retry != null) retry.run();
    }
    void rate(boolean positive) {
        PandoraProtocol.Track selected = track;
        if (selected == null || feedbackBusy || selected.rating == (positive ? 1 : -1)) return;
        int generation = authGeneration; feedbackBusy = true; message = ""; changed();
        io.execute(() -> {
            try {
                api.feedback(selected.token, positive);
                main.post(() -> {
                    if (generation != authGeneration) return;
                    feedbackBusy = false; selected.rating = positive ? 1 : -1;
                    if (!positive && track == selected && playback != null) playback.next();
                    changed();
                });
            } catch (Exception e) { main.post(() -> { if (generation == authGeneration) { feedbackBusy = false; fail(e, () -> { if (track == selected) rate(positive); }); } }); }
        });
    }
    void logout() {
        ++authGeneration;
        if (playback != null) playback.clearPlayback();
        signedIn = busy = feedbackBusy = takeover = false; stations = new ArrayList<>(); history.clear();
        station = null; track = null; message = ""; verification = null; verificationRetry = null;
        io.execute(() -> { credentials.clear(); api.clear(); });
        changed();
    }
}
