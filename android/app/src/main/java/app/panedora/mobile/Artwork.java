package app.panedora.mobile;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Handler;
import android.os.Looper;
import android.util.LruCache;
import android.widget.ImageView;
import java.io.ByteArrayOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class Artwork {
    private static final ExecutorService workers = Executors.newFixedThreadPool(2);
    private static final Handler main = new Handler(Looper.getMainLooper());
    private static final LruCache<String, Bitmap> cache = new LruCache<>(8 * 1024 * 1024) {
        @Override protected int sizeOf(String key, Bitmap bitmap) { return bitmap.getByteCount(); }
    };
    static void load(ImageView view, String url) {
        view.setTag(url); view.setImageResource(R.drawable.panedora_mark);
        if (url == null || url.isEmpty()) return;
        Bitmap cached = cache.get(url); if (cached != null) { view.setImageBitmap(cached); return; }
        workers.execute(() -> {
            HttpURLConnection connection = null;
            try {
                if (PandoraProtocol.https(url).isEmpty()) return;
                connection = (HttpURLConnection) new URL(url).openConnection(); connection.setConnectTimeout(10000); connection.setReadTimeout(10000);
                byte[] bytes;
                try (var input = connection.getInputStream(); var buffer = new ByteArrayOutputStream()) {
                    byte[] block = new byte[8192]; int n;
                    while ((n = input.read(block)) != -1) { buffer.write(block, 0, n); if (buffer.size() > 4_000_000) return; }
                    bytes = buffer.toByteArray();
                }
                BitmapFactory.Options options = new BitmapFactory.Options(); options.inJustDecodeBounds = true;
                BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
                options.inSampleSize = 1;
                while (Math.max(options.outWidth, options.outHeight) / options.inSampleSize > 700) options.inSampleSize *= 2;
                options.inJustDecodeBounds = false;
                Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
                if (bitmap != null) { cache.put(url, bitmap); main.post(() -> { if (url.equals(view.getTag())) view.setImageBitmap(bitmap); }); }
            } catch (Exception ignored) { /* Keep the Panedora mark if artwork is unavailable. */ }
            finally { if (connection != null) connection.disconnect(); }
        });
    }
}
