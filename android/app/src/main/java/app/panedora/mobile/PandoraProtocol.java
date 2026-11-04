package app.panedora.mobile;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.net.URI;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

/** The same REST payloads and subscription rules used by pandora-api.js. */
final class PandoraProtocol {
    static final class Station {
        final String id, name, art;
        Station(String id, String name, String art) { this.id = id; this.name = name; this.art = art; }
    }
    static final class Track {
        final String token, title, artist, album, audio, art;
        final int seconds;
        int rating;
        Track(String token, String title, String artist, String album, String audio, String art, int seconds, int rating) {
            this.token = token; this.title = title; this.artist = artist; this.album = album;
            this.audio = audio; this.art = art; this.seconds = seconds; this.rating = rating;
        }
    }
    static JSONObject body(Object... values) throws JSONException {
        JSONObject result = new JSONObject();
        for (int i = 0; i < values.length; i += 2) result.put((String) values[i], values[i + 1] == null ? JSONObject.NULL : values[i + 1]);
        return result;
    }
    static JSONObject loginBody(String email, String password) throws JSONException {
        return body("username", email, "password", password, "existingAuthToken", null, "keepLoggedIn", true);
    }
    static JSONObject playlistBody(String station, boolean first) throws JSONException {
        return body("stationId", station, "isStationStart", first, "fragmentRequestReason", "Normal",
            "audioFormat", "aacplus", "startingAtTrackId", null, "onDemandArtistMessageArtistUidHex", null, "onDemandArtistMessageIdHex", null);
    }
    static boolean paid(JSONObject response) {
        JSONObject config = response.optJSONObject("config");
        if (config != null) {
            String branding = config.optString("branding");
            if (!branding.isEmpty() && !branding.equals("Pandora")) return true;
            JSONArray flags = config.optJSONArray("flags");
            for (int i = 0; flags != null && i < flags.length(); i++) {
                if (Arrays.asList("onDemand", "adFreeSkip", "adFreeReplay", "highQualityStreamingAvailable").contains(flags.optString(i))) return true;
            }
        }
        JSONObject adkv = response.optJSONObject("adkv");
        return Boolean.TRUE.equals(response.opt("highQualityStreamingEnabled")) ||
            Boolean.TRUE.equals(response.opt("smartConversionDisabled")) || (adkv != null && "0".equals(adkv.optString("iat")));
    }
    static boolean conflict(JSONObject value) {
        if ("STREAM_VIOLATION".equals(value.optString("errorString")) || value.optString("trackType").contains("SimStreamViolation")) return true;
        JSONArray tracks = value.optJSONArray("tracks");
        for (int i = 0; tracks != null && i < tracks.length(); i++) if (tracks.optJSONObject(i) != null && conflict(tracks.optJSONObject(i))) return true;
        return false;
    }
    static String https(String value) {
        try {
            URI uri = new URI(value.trim());
            if (uri.getHost() == null || uri.getUserInfo() != null || !("https".equals(uri.getScheme()) || "http".equals(uri.getScheme()))) return "";
            return "http".equals(uri.getScheme()) ? "https" + value.trim().substring(4) : value.trim();
        } catch (Exception ignored) { return ""; }
    }
    static String artwork(JSONArray array) {
        List<JSONObject> candidates = new ArrayList<>();
        for (int i = 0; array != null && i < array.length(); i++) {
            JSONObject item = array.optJSONObject(i);
            if (item != null && !https(item.optString("url")).isEmpty()) candidates.add(item);
        }
        candidates.sort(Comparator.comparingInt((JSONObject item) -> item.optInt("size")).reversed());
        return candidates.isEmpty() ? "" : https(candidates.get(0).optString("url"));
    }
    static List<Station> stations(JSONObject value) {
        List<Station> result = new ArrayList<>();
        JSONArray list = value.optJSONArray("stations");
        for (int i = 0; list != null && i < list.length(); i++) {
            JSONObject item = list.optJSONObject(i);
            if (item != null && !item.optString("stationId").isEmpty()) result.add(new Station(item.optString("stationId"), item.optString("name", "Station"), artwork(item.optJSONArray("art"))));
        }
        return result;
    }
    static List<Track> tracks(JSONObject value) {
        List<Track> result = new ArrayList<>();
        JSONArray list = value.optJSONArray("tracks");
        for (int i = 0; list != null && i < list.length(); i++) {
            JSONObject t = list.optJSONObject(i);
            if (t == null) continue;
            String type = t.optString("trackType").toLowerCase(Locale.ROOT);
            // Never treat advertisements or stream-takeover notices as music.
            if (type.contains("advert") || type.startsWith("ad") || type.contains("simstream") || t.optBoolean("isAd")) continue;
            String audio = https(t.optString("audioURL"));
            if (audio.isEmpty() || t.optString("trackToken").isEmpty()) continue;
            result.add(new Track(t.optString("trackToken"), t.optString("songTitle", "Unknown song"),
                t.optString("artistName", "Unknown artist"), t.optString("albumTitle"), audio,
                artwork(t.optJSONArray("albumArt")), t.optInt("trackLength"), t.optInt("rating", t.optInt("songRating"))));
        }
        return result;
    }
}
