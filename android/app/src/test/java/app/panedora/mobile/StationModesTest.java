package app.panedora.mobile;

import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class StationModesTest {
    private static JSONObject fixture() throws Exception {
        return new JSONObject("{\"interactiveRadioAvailable\":true,\"currentModeId\":\"1091989\",\"availableModes\":[{\"modeId\":0,\"modeName\":\"My Station\",\"isModeAvailable\":true},{\"modeId\":1091989,\"modeName\":\"Energy Boost\",\"modeDescription\":\"More energy.\",\"isModeAvailable\":true},{\"modeId\":5,\"modeName\":\"Artist Only\",\"isModeAvailable\":true},{\"modeId\":7,\"modeName\":\"Premium Mix\",\"isPremiumOnly\":true,\"isModeAvailable\":true},{\"modeId\":null,\"modeName\":\"Invalid\"},{\"modeId\":0,\"modeName\":\"Duplicate\"}]}");
    }
    @Test public void usesRealIdsAndRequiresBothSubscriptionAndStationEligibility() throws Exception {
        for (boolean nested:new boolean[]{false,true}) {
            JSONObject response=fixture(); if (nested) response=new JSONObject().put("result",response).put("stat","ok");
            var plus=PandoraProtocol.modes(response,false); assertTrue(plus.active(1091989)); assertEquals(4,plus.choices.size());
            assertFalse(plus.find(5).available); assertFalse(plus.find(7).available); assertTrue(plus.find(5).premiumOnly);
            var premium=PandoraProtocol.modes(response,true); assertTrue(premium.find(5).available); assertTrue(premium.find(7).available);
        }
    }
    @Test public void premiumProofMustComeFromAVerifiedPremiumLogin() throws Exception {
        assertTrue(PandoraProtocol.premium(new JSONObject("{\"authToken\":\"premium\",\"config\":{\"branding\":\"PandoraPremium\"}}")));
        assertTrue(PandoraProtocol.premium(new JSONObject("{\"authToken\":\"premium\",\"config\":{\"flags\":[\"onDemand\"]}}")));
        for (String response:new String[]{"{\"config\":{\"branding\":\"PandoraPremium\"}}","{\"authToken\":null,\"config\":{\"branding\":\"PandoraPremium\"}}","{\"authToken\":\"plus\",\"config\":{\"branding\":\"PandoraPlus\",\"flags\":[\"onDemand\",\"adFreeSkip\"]}}","{\"authToken\":\"free\",\"config\":{\"branding\":\"Pandora\",\"flags\":[\"onDemand\"]}}","{\"authToken\":\"unknown\",\"highQualityStreamingEnabled\":true}"}) assertFalse(PandoraProtocol.premium(new JSONObject(response)));
    }
    @Test public void missingUnavailableAndRevokedModesAreNeverConfirmed() throws Exception {
        assertFalse(PandoraProtocol.modes(new JSONObject("{\"interactiveRadioAvailable\":false}"),true).available);
        JSONObject response=fixture().put("interactiveRadioAvailable",false); assertFalse(PandoraProtocol.modes(response,true).active(1091989));
        response=fixture(); response.getJSONArray("availableModes").getJSONObject(1).put("isModeAvailable",false); assertFalse(PandoraProtocol.modes(response,true).active(1091989));
        response=fixture().put("currentModeId",JSONObject.NULL); assertFalse(PandoraProtocol.modes(response,true).active(1091989));
        assertThrows(Exception.class,() -> PandoraProtocol.modes(new JSONObject(),true));
        assertThrows(Exception.class,() -> PandoraProtocol.modes(new JSONObject().put("stat","fail").put("result",fixture()),true));
    }
    @Test public void idsRejectCoercionFractionsNegativesAndUnsafeIntegers() {
        for (Object invalid:new Object[]{null,JSONObject.NULL,true,-1,1.5,"1.5","-1","abc",9007199254740992L}) assertNull(PandoraProtocol.modeId(invalid));
        assertEquals(Long.valueOf(0),PandoraProtocol.modeId("0")); assertEquals(Long.valueOf(1091989),PandoraProtocol.modeId(1091989));
    }
}
