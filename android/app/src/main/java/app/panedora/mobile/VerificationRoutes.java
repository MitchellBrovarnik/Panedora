package app.panedora.mobile;

import android.content.SharedPreferences;

/** Remembers a script route, never challenge responses or authentication data. */
final class VerificationRoutes {
    private final SharedPreferences preferences;
    VerificationRoutes(SharedPreferences preferences) { this.preferences = preferences; }
    boolean alternateFirst() { return preferences.getBoolean("alternateFirst",true); }
    void remember(String route) {
        if ("provider".equals(route) || "pandora".equals(route)) preferences.edit().putBoolean("alternateFirst","provider".equals(route)).apply();
    }
}
