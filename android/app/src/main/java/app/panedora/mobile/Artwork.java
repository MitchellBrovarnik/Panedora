package app.panedora.mobile;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.drawable.Drawable;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageView;
import com.bumptech.glide.Glide;
import com.bumptech.glide.Priority;
import com.bumptech.glide.RequestBuilder;
import com.bumptech.glide.RequestManager;
import com.bumptech.glide.load.engine.DiskCacheStrategy;
import com.bumptech.glide.request.target.CustomTarget;
import com.bumptech.glide.request.transition.Transition;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;

final class Artwork {
    static int playerSizeDp(Context context) {
        var metrics = context.getResources().getDisplayMetrics();
        return Math.max(160,Math.min(320,Math.min(Math.round(metrics.widthPixels / metrics.density) - 48,Math.round(metrics.heightPixels / metrics.density) - 620)));
    }
    private static int pixels(Context context,int dp) { return Math.round(dp * context.getResources().getDisplayMetrics().density); }
    private static RequestBuilder<Bitmap> bitmap(RequestManager manager,String source,int size,Priority priority) {
        return manager.asBitmap().load(source).override(Math.min(size,1024),Math.min(size,1024)).centerCrop()
            .diskCacheStrategy(DiskCacheStrategy.ALL).dontAnimate().timeout(10000).priority(priority);
    }
    static void load(ImageView view, String url, int pixels, boolean currentSong) {
        // The Activity owns and clears these targets when it replaces its view tree.
        // Application scope lets a replacement view join a download already in progress.
        var manager = Glide.with(view.getContext().getApplicationContext());
        String source = PandoraProtocol.https(url);
        if (source.isEmpty()) {
            manager.clear(view); view.setImageResource(R.drawable.panedora_mark); return;
        }
        var request = bitmap(manager,source,pixels,currentSong ? Priority.IMMEDIATE : Priority.LOW)
            .placeholder(R.drawable.panedora_mark).error(R.drawable.panedora_mark);
        if (currentSong) {
            // Current/queued covers have their own workers, outside the station queue.
            request = request.useUnlimitedSourceGeneratorsPool(true);
            int thumbnail = Math.round(42 * view.getResources().getDisplayMetrics().density);
            request = request.thumbnail(bitmap(manager,source,thumbnail,Priority.IMMEDIATE).onlyRetrieveFromCache(true));
        }
        request.into(view);
    }

    /** Holds decoded main/compact covers for only the current song and the next two. */
    static final class Preloader {
        private final Context context;
        private final RequestManager manager;
        private final Handler handler = new Handler(Looper.getMainLooper());
        private final Map<String,Entry> entries = new LinkedHashMap<>();
        private int large, small;
        Preloader(Context context) { this.context = context.getApplicationContext(); manager = Glide.with(this.context); }
        void update(List<PandoraProtocol.Track> queue,int current) {
            int mainSize = Math.min(1024,pixels(context,playerSizeDp(context))), compactSize = pixels(context,42);
            if (mainSize != large || compactSize != small) { clear(); large = mainSize; small = compactSize; }
            var wanted = new LinkedHashSet<String>();
            for (int i = Math.max(0,current); i < Math.min(queue.size(),Math.max(0,current) + 3); i++) {
                String source = PandoraProtocol.https(queue.get(i).art); if (!source.isEmpty()) wanted.add(source);
            }
            for (String source : new ArrayList<>(entries.keySet())) if (!wanted.contains(source) || entries.get(source).failed) entries.remove(source).close();
            for (String source : wanted) if (!entries.containsKey(source)) {
                Entry entry = new Entry(source); entries.put(source,entry);
                bitmap(manager,source,large,Priority.HIGH).useUnlimitedSourceGeneratorsPool(true).into(entry.full);
            }
        }
        boolean ready(String source) { Entry entry = entries.get(PandoraProtocol.https(source)); return entry != null && entry.fullReady && entry.compactReady; }
        void clear() { for (Entry entry : entries.values()) entry.close(); entries.clear(); }
        private final class Entry {
            boolean active = true, fullReady, compactReady, failed;
            final CustomTarget<Bitmap> full, compact;
            Entry(String source) {
                compact = new CustomTarget<Bitmap>() {
                    @Override public void onResourceReady(@NonNull Bitmap image,@Nullable Transition<? super Bitmap> transition) { compactReady = true; }
                    @Override public void onLoadCleared(@Nullable Drawable placeholder) { compactReady = false; }
                    @Override public void onLoadFailed(@Nullable Drawable error) { failed = true; }
                };
                full = new CustomTarget<Bitmap>() {
                    @Override public void onResourceReady(@NonNull Bitmap image,@Nullable Transition<? super Bitmap> transition) {
                        fullReady = true;
                        // Decode the compact size only after the source is on disk, avoiding a second download.
                        handler.post(() -> { if (active) bitmap(manager,source,small,Priority.HIGH).onlyRetrieveFromCache(true).useUnlimitedSourceGeneratorsPool(true).into(compact); });
                    }
                    @Override public void onLoadCleared(@Nullable Drawable placeholder) { fullReady = false; }
                    @Override public void onLoadFailed(@Nullable Drawable error) { failed = true; }
                };
            }
            void close() { active = false; manager.clear(full); manager.clear(compact); }
        }
    }

    static void clear(View view) {
        if (view instanceof ImageView image) Glide.with(view.getContext().getApplicationContext()).clear(image);
        if (view instanceof ViewGroup group) for (int i = 0; i < group.getChildCount(); i++) clear(group.getChildAt(i));
    }
}
