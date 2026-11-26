package io.github.awayfn.synapse;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Les nouvelles versions de l'application, publiées sur GitHub (page « Releases » du dépôt).
 * (V7 : le Synapse central, lui, est trouvé par la page de Synapse elle-même : dernière adresse qui a marché, ou celle
 * qu'il publie sur GitHub, branche synapse-adresse.) Tout ceci se fait hors du fil principal (réseau).
 */
final class Central {
    static final String PREFS = "synapse";

    private Central() {}

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String read(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        int total = 0;
        while ((n = in.read(buf)) > 0 && total < 300_000) {
            out.write(buf, 0, n);
            total += n;
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    static String get(String url, String accept, int timeoutMs) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            c.setUseCaches(false);
            c.setRequestProperty("User-Agent", "SynapseAndroid/" + BuildConfig.VERSION_NAME);
            if (accept != null) c.setRequestProperty("Accept", accept);
            if (c.getResponseCode() != 200) return null;
            try (InputStream in = c.getInputStream()) {
                return read(in);
            }
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** « 7.0.10 » > « 7.0.9 » */
    static boolean newer(String latest, String current) {
        if (latest == null || current == null) return false;
        String[] a = latest.replaceAll("^[vV]", "").split("[.\\-+]");
        String[] b = current.replaceAll("^[vV]", "").split("[.\\-+]");
        for (int i = 0; i < 3; i++) {
            int x = i < a.length ? num(a[i]) : 0;
            int y = i < b.length ? num(b[i]) : 0;
            if (x != y) return x > y;
        }
        return false;
    }

    private static int num(String s) {
        try {
            return Integer.parseInt(s.replaceAll("\\D", ""));
        } catch (Exception e) {
            return 0;
        }
    }

    /** La dernière version publiée sur GitHub (« v7.0.1 »), ou null */
    static String latestRelease() {
        String body = get("https://api.github.com/repos/" + BuildConfig.DEPOT + "/releases/latest", "application/vnd.github+json", 8000);
        if (body == null) return null;
        try {
            return new JSONObject(body).optString("tag_name", null);
        } catch (Exception e) {
            return null;
        }
    }
}
