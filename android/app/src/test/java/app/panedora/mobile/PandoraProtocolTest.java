package app.panedora.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class PandoraProtocolTest {
    @Test public void paidStatusRequiresPositiveEvidence() throws Exception {
        assertFalse(PandoraProtocol.paid(new JSONObject()));
        assertFalse(PandoraProtocol.paid(new JSONObject("{\"config\":{\"branding\":\"Pandora\",\"flags\":[\"adSupportedSkip\"]},\"adkv\":{\"iat\":\"1\"}}")));
        assertTrue(PandoraProtocol.paid(new JSONObject("{\"config\":{\"branding\":\"PandoraPlus\"}}")));
        assertTrue(PandoraProtocol.paid(new JSONObject("{\"config\":{\"flags\":[\"onDemand\"]}}")));
    }
    @Test public void requestsMatchTheDesktopProtocol() throws Exception {
        JSONObject login = PandoraProtocol.loginBody("test@example.invalid", "test password");
        assertTrue(login.isNull("existingAuthToken")); assertTrue(login.getBoolean("keepLoggedIn"));
        JSONObject playlist = PandoraProtocol.playlistBody("station-7", true);
        assertEquals("station-7", playlist.getString("stationId")); assertTrue(playlist.getBoolean("isStationStart"));
        assertEquals("aacplus", playlist.getString("audioFormat")); assertTrue(playlist.isNull("startingAtTrackId"));
        assertFalse(PandoraProtocol.playlistBody("station-7", false).getBoolean("isStationStart"));
    }
    @Test public void parsesRealFieldNamesAndRejectsNonMusic() throws Exception {
        JSONObject song = new JSONObject("{\"trackToken\":\"track-7\",\"songTitle\":\"After Hours\",\"artistName\":\"Northbound\",\"audioURL\":\"https://audio.example/song.aac\",\"rating\":\"1\",\"trackLength\":192}");
        JSONObject ad = new JSONObject(song.toString()).put("trackType", "AdTrack");
        JSONObject invalid = new JSONObject(song.toString()).put("audioURL", "file:///private/file");
        var tracks = PandoraProtocol.tracks(new JSONObject().put("tracks", new JSONArray().put(song).put(ad).put(invalid)));
        assertEquals(1, tracks.size()); assertEquals("After Hours", tracks.get(0).title); assertEquals(1, tracks.get(0).rating); assertEquals(192, tracks.get(0).seconds);
        assertTrue(PandoraProtocol.conflict(new JSONObject("{\"tracks\":[{\"trackType\":\"SimStreamViolationItem\"}]}")));
        assertTrue(PandoraProtocol.conflict(new JSONObject().put("message", "SimStreamViolation: another device is playing")));
    }
    @Test public void artworkUsesTheLargestValidImageAndHttps() throws Exception {
        JSONArray art = new JSONArray("[{\"size\":1080},{\"size\":500,\"url\":\"http://images.example/cover.jpg\"},{\"size\":100,\"url\":\"https://images.example/small.jpg\"}]");
        assertEquals("https://images.example/cover.jpg", PandoraProtocol.artwork(art));
        assertEquals("", PandoraProtocol.https("https://secret@images.example/a"));
        assertEquals("", PandoraProtocol.https("javascript:alert(1)"));
        assertEquals("", PandoraProtocol.artwork(null));
    }
    @Test public void undoLookupRequiresTheSameRecordingAndStation() throws Exception {
        var track = new PandoraProtocol.Track("token","Same title","Artist","Album","","",180,1);
        track.stationId = "station-a"; track.musicId = "S123";
        JSONArray feedback = new JSONArray("[{\"stationId\":\"station-b\",\"musicId\":\"S123\",\"feedbackId\":\"wrong-station\"},{\"stationId\":\"station-a\",\"musicId\":\"S456\",\"songTitle\":\"Same title\",\"feedbackId\":\"wrong-song\"},{\"stationId\":\"station-a\",\"musicId\":\"S123\",\"feedbackId\":\"correct\"}]");
        assertEquals("correct",PandoraProtocol.matchingFeedback(feedback,track));
        track.musicId = ""; assertEquals("",PandoraProtocol.matchingFeedback(feedback,track));
    }
    @Test public void shuffleRecognizesServerFlagsAndTheDedicatedEndpoint() throws Exception {
        for (String fields : new String[]{"\"isQuickMix\":true","\"isShuffle\":true","\"stationType\":\"QUICKMIX\"","\"name\":\"Shuffle\""}) {
            var station = PandoraProtocol.station(new JSONObject("{\"stationId\":\"shuffle-7\"," + fields + "}"),false);
            assertTrue(station.shuffle); assertEquals("Shuffle Stations",station.name);
        }
        assertTrue(PandoraProtocol.station(new JSONObject("{\"stationId\":\"shuffle-8\"}"),true).shuffle);
        assertFalse(PandoraProtocol.station(new JSONObject("{\"stationId\":\"normal\",\"name\":\"Radio\"}"),false).shuffle);
        assertNull(PandoraProtocol.station(new JSONObject("{\"stationId\":null}"),true));
        assertNull(PandoraProtocol.station(new JSONObject("{\"stationId\":\" \"}"),true));
    }
}
