package app.panedora.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Color;
import androidx.core.graphics.ColorUtils;

/** Local appearance preferences; changing them never touches the playback session. */
final class Appearance {
    static final int ADAPTIVE_FALLBACK=0xff7c5bf5;
    static final class Theme {
        final String id, name;
        final int background, tint, accent;
        Theme(String id,String name,int background,int tint,int accent) { this.id=id; this.name=name; this.background=background; this.tint=tint; this.accent=accent; }
    }
    static final Theme[] THEMES = {
        new Theme("midnight","Midnight Violet",0xff121018,0xff8461b4,0xffc4adff),
        new Theme("ocean","Deep Ocean",0xff060d1a,0xff2563b0,0xff7bb6ff),
        new Theme("emerald","Emerald Forest",0xff060f0a,0xff16845b,0xff63dba9),
        new Theme("sunset","Sunset Blaze",0xff120606,0xffb4511a,0xffffb174),
        new Theme("rose","Rose Quartz",0xff120610,0xffa43a79,0xffff94ca),
        new Theme("arctic","Arctic Frost",0xff060c14,0xff387a91,0xff67e8f9),
        new Theme("neon","Neon Cyber",0xff050510,0xff8044be,0xff22d3ee),
        new Theme("classic","Classic Dark",0xff0a0a0a,0xff606060,0xff66d98f),
        new Theme("adaptive","Adaptive (Dynamic)",0xff0a0a0a,ADAPTIVE_FALLBACK,ADAPTIVE_FALLBACK)
    };
    static final class Palette {
        final int background, tint, accent;
        Palette(int background,int tint,int accent) { this.background=background; this.tint=tint; this.accent=accent; }
        String key() { return background+":"+tint+":"+accent; }
    }
    private final SharedPreferences preferences;
    Appearance(Context context) { preferences=context.getSharedPreferences("appearance",Context.MODE_PRIVATE); }
    Theme theme() {
        String id=preferences.getString("theme","midnight");
        for (Theme theme:THEMES) if (theme.id.equals(id)) return theme;
        return THEMES[0];
    }
    boolean adaptive() { return theme().id.equals("adaptive"); }
    int accent() { return adaptive() ? ADAPTIVE_FALLBACK : preferences.getInt("accent",theme().accent); }
    Palette palette(Integer artworkAccent) {
        Theme theme=theme();
        if (!adaptive()) return new Palette(theme.background,theme.tint,accent());
        int tint=artworkAccent==null ? ADAPTIVE_FALLBACK : artworkAccent;
        int background=blend(theme.background,tint,.06f);
        return new Palette(background,tint,readableAccent(tint,background));
    }
    void select(Theme theme) { preferences.edit().putString("theme",theme.id).remove("accent").apply(); }
    void accent(int color) { preferences.edit().putInt("accent",color|0xff000000).apply(); }
    void resetAccent() { preferences.edit().remove("accent").apply(); }
    boolean readable(int color) { return ColorUtils.calculateContrast(color|0xff000000,theme().background)>=4.5; }
    static int blend(int base,int color,float amount) { return ColorUtils.blendARGB(base,color,amount); }
    static String hex(int color) { return String.format(java.util.Locale.US,"#%06X",color&0xffffff); }

    /** Same 50×50, rounded RGB histogram as desktop; never inspect the placeholder. */
    static int artworkAccent(Bitmap image) {
        Bitmap sample=Bitmap.createScaledBitmap(image,50,50,false);
        int[] pixels=new int[2500]; sample.getPixels(pixels,0,50,0,0,50,50);
        if (sample!=image) sample.recycle();
        int[] counts=new int[27*27*27]; int dominant=ADAPTIVE_FALLBACK, maximum=0;
        for (int pixel:pixels) {
            int r=Color.red(pixel), g=Color.green(pixel), b=Color.blue(pixel);
            if (Color.alpha(pixel)<128 || (r<30 && g<30 && b<30) || (r>240 && g>240 && b>240)) continue;
            int bucket=(Math.round(r/10f)*27+Math.round(g/10f))*27+Math.round(b/10f);
            if (++counts[bucket]>maximum) { maximum=counts[bucket]; dominant=pixel|0xff000000; }
        }
        if (maximum==0) return ADAPTIVE_FALLBACK;
        float[] hsl=new float[3]; ColorUtils.colorToHSL(dominant,hsl);
        if (hsl[2]<.4f) hsl[2]=.5f;
        else if (hsl[2]>.75f) { hsl[1]=Math.max(hsl[1],.5f); hsl[2]=.65f; }
        return ColorUtils.HSLToColor(hsl);
    }
    private static int readableAccent(int color,int background) {
        float[] hsl=new float[3]; ColorUtils.colorToHSL(color,hsl);
        while (ColorUtils.calculateContrast(color,background)<4.5 && hsl[2]<1f) {
            hsl[2]=Math.min(1f,hsl[2]+.025f); color=ColorUtils.HSLToColor(hsl);
        }
        return color;
    }
}
