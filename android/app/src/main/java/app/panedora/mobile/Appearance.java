package app.panedora.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import androidx.core.graphics.ColorUtils;

/** Local appearance preferences; changing them never touches the playback session. */
final class Appearance {
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
        new Theme("classic","Classic Dark",0xff0a0a0a,0xff606060,0xff66d98f)
    };
    private final SharedPreferences preferences;
    Appearance(Context context) { preferences=context.getSharedPreferences("appearance",Context.MODE_PRIVATE); }
    Theme theme() {
        String id=preferences.getString("theme","midnight");
        for (Theme theme:THEMES) if (theme.id.equals(id)) return theme;
        return THEMES[0];
    }
    int accent() { return preferences.getInt("accent",theme().accent); }
    String key() { return theme().id+":"+accent(); }
    void select(Theme theme) { preferences.edit().putString("theme",theme.id).remove("accent").apply(); }
    void accent(int color) { preferences.edit().putInt("accent",color|0xff000000).apply(); }
    void resetAccent() { preferences.edit().remove("accent").apply(); }
    boolean readable(int color) { return ColorUtils.calculateContrast(color|0xff000000,theme().background)>=4.5; }
    static int blend(int base,int color,float amount) { return ColorUtils.blendARGB(base,color,amount); }
    static String hex(int color) { return String.format(java.util.Locale.US,"#%06X",color&0xffffff); }
}
