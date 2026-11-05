package app.panedora.mobile;

import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageView;
import com.bumptech.glide.Glide;
import com.bumptech.glide.Priority;
import com.bumptech.glide.load.engine.DiskCacheStrategy;

final class Artwork {
    static void load(ImageView view, String url, int pixels, boolean currentSong) {
        // The Activity owns and clears these targets when it replaces its view tree.
        // Application scope lets a replacement view join a download already in progress.
        var manager = Glide.with(view.getContext().getApplicationContext());
        String source = PandoraProtocol.https(url);
        if (source.isEmpty()) {
            manager.clear(view); view.setImageResource(R.drawable.panedora_mark); return;
        }
        var request = manager.asBitmap().load(source)
            .override(Math.min(pixels, 1024), Math.min(pixels, 1024)).centerCrop()
            .diskCacheStrategy(DiskCacheStrategy.ALL)
            .placeholder(R.drawable.panedora_mark).error(R.drawable.panedora_mark)
            .dontAnimate().timeout(10000)
            .priority(currentSong ? Priority.IMMEDIATE : Priority.LOW);
        if (currentSong) {
            // Only the one visible song-cover target uses this pool. Slow station
            // downloads must not occupy every worker available to the current song.
            request = request.useUnlimitedSourceGeneratorsPool(true);
            int thumbnail = Math.round(42 * view.getResources().getDisplayMetrics().density);
            request = request.thumbnail(manager.asBitmap().load(source)
                .override(thumbnail, thumbnail).centerCrop().dontAnimate()
                .diskCacheStrategy(DiskCacheStrategy.ALL).onlyRetrieveFromCache(true));
        }
        request.into(view);
    }

    static void clear(View view) {
        if (view instanceof ImageView image) Glide.with(view.getContext().getApplicationContext()).clear(image);
        if (view instanceof ViewGroup group) for (int i = 0; i < group.getChildCount(); i++) clear(group.getChildAt(i));
    }
}
