package io.github.awayfn.synapse;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Trouver le Synapse central. Son adresse Internet peut changer (adresse gratuite, nouvelle à chaque redémarrage de
 * Synapse sur le PC du créateur) : il la publie sur GitHub, dans son dépôt (branche synapse-adresse, fichier
 * adresse.json). L'application essaie, dans l'ordre :
 *   1. l'adresse choisie à la main (s'il y en a une) ;
 *   2. la dernière adresse qui a marché ;
 *   3. l'adresse publiée sur GitHub ;
 *   4. l'adresse fixe (si le Synapse central en a une).
 * Une adresse n'est retenue que si un serveur Synapse y répond (/api/health).
 * Tout ceci se fait hors du fil principal (réseau).
 */
final class Central {
    static final String PREFS = "synapse";
    static final String KEY_LAST = "adresse";
    static final String KEY_MANUAL = "adresse_manuelle";
    static final String KEY_TOKEN = "jeton";
    static final String KEY_TOKEN_HOST = "jeton_hote";

    private Central() {}

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** « https://exemple.fr/ » → « https://exemple.fr » ; une adresse invalide → null */
    static String clean(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        if (!s.matches("(?i)^https?://[^\\s/?#]+$")) return null;
        return s;
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

    /** Un serveur Synapse répond-il à cette adresse ? */
    static boolean healthy(String base) {
        if (base == null) return false;
        String body = get(base + "/api/health", "application/json", 7000);
        if (body == null) return false;
        try {
            return new JSONObject(body).optBoolean("ok", false);
        } catch (Exception e) {
            return false;
        }
    }

    /** L'adresse publiée sur GitHub par le Synapse central (API GitHub, sinon la copie « raw ») */
    static String published() {
        String depot = BuildConfig.DEPOT;
        if (depot == null || depot.isEmpty()) return null;
        String[][] sources = {
            {"https://api.github.com/repos/" + depot + "/contents/" + BuildConfig.FICHIER + "?ref=" + BuildConfig.BRANCHE, "application/vnd.github.raw+json"},
            {"https://raw.githubusercontent.com/" + depot + "/" + BuildConfig.BRANCHE + "/" + BuildConfig.FICHIER + "?t=" + System.currentTimeMillis(), null},
        };
        for (String[] s : sources) {
            String body = get(s[0], s[1], 8000);
            if (body == null) continue;
            try {
                JSONObject j = new JSONObject(body);
                if (!"synapse".equals(j.optString("app"))) continue;
                String a = clean(j.optString("adresse", null));
                if (a != null) return a;
            } catch (Exception ignored) {
                // fichier illisible : la source suivante
            }
        }
        return null;
    }

    /** La première adresse où un Synapse répond, ou null (serveur éteint, pas de réseau) */
    static String resolve(Context ctx) {
        SharedPreferences p = prefs(ctx);
        List<String> tried = new ArrayList<>();
        String[] first = {clean(p.getString(KEY_MANUAL, null)), clean(p.getString(KEY_LAST, null))};
        for (String a : first) {
            if (a != null && !tried.contains(a)) {
                tried.add(a);
                if (healthy(a)) return remember(ctx, a);
            }
        }
        String pub = published();
        if (pub != null && !tried.contains(pub)) {
            tried.add(pub);
            if (healthy(pub)) return remember(ctx, pub);
        }
        String fixed = clean(BuildConfig.ADRESSE_FIXE);
        if (fixed != null && !tried.contains(fixed) && healthy(fixed)) return remember(ctx, fixed);
        return null;
    }

    static String remember(Context ctx, String a) {
        prefs(ctx).edit().putString(KEY_LAST, a).apply();
        return a;
    }

    /** « 6.0.10 » > « 6.0.9 » */
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

    /** La dernière version publiée sur GitHub (« 6.0.1 »), ou null */
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
