package io.github.awayfn.synapse;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Synapse pour Android (V7) : Synapse est DANS l'application. Il s'ouvre et marche sur le téléphone, même sans réseau
 * et même quand le PC qui héberge le Synapse central est éteint : le cerveau est gardé sur le téléphone.
 * On s'y crée un compte au premier lancement (même sans réseau : il est enregistré dès que possible) ; tout se
 * synchronise avec le Synapse central dès qu'il répond, et on retrouve tout sur son PC avec le même compte.
 *
 *  - Les pages de Synapse (app/dist, copiées dans l'APK) sont servies depuis l'application elle-même, à l'adresse
 *    réservée https://appassets.androidplatform.net (jamais demandée sur Internet) : la copie du cerveau garde la même
 *    adresse, même quand celle du Synapse central change.
 *  - Le Synapse central est trouvé par la page elle-même (dernière adresse, ou celle publiée sur GitHub).
 *  - Le réseau du téléphone change (Wi-Fi ↔ 4G/5G) : la page est prévenue et se resynchronise aussitôt.
 *  - Le bouton retour fait comme la touche Échap (ferme ce qui est ouvert) ; s'il n'y a plus rien à fermer,
 *    l'application passe en arrière-plan.
 */
public class MainActivity extends Activity {
    static final String APP_HOST = "appassets.androidplatform.net";
    private static final String APP_URL = "https://" + APP_HOST + "/";
    private static final String WEB = "web";
    private static final int FILE_REQUEST = 41;
    /** Les pages de Synapse ne parlent qu'à elles-mêmes, au Synapse central et à GitHub (son adresse) */
    private static final String CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
            + "font-src 'self' data:; connect-src 'self' https: http:; worker-src 'self' blob:; base-uri 'self'; form-action 'self'";

    private WebView web;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private ConnectivityManager.NetworkCallback netCallback;
    private ValueCallback<Uri[]> fileCallback;
    private long lastUpdateCheck = 0;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.BLACK);
        getWindow().setNavigationBarColor(Color.BLACK);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        // le cerveau gardé sur le téléphone (la page l'écrit dans son stockage local)
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setTextZoom(100);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        // un serveur Synapse sur le même Wi-Fi a une adresse en http (ex. http://192.168.1.20:5173)
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        // le serveur reconnaît l'application (et l'espace admin la compte comme « application Android »)
        s.setUserAgentString(s.getUserAgentString() + " SynapseAndroid/" + BuildConfig.VERSION_NAME);

        web.addJavascriptInterface(new Bridge(), "SynapseAndroid");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> openExternal(url));

        if (state != null) web.restoreState(state);
        if (web.getUrl() == null) web.loadUrl(APP_URL);
        watchNetwork();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    private void openExternal(String url) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "Aucune application pour ouvrir ce lien", Toast.LENGTH_SHORT).show();
        }
    }

    // ───────────────────────── les pages de Synapse, depuis l'APK

    private static String mimeOf(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".webmanifest")) return "application/manifest+json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".webp")) return "image/webp";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".woff")) return "font/woff";
        if (p.endsWith(".ttf")) return "font/ttf";
        if (p.endsWith(".wasm")) return "application/wasm";
        if (p.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    private static boolean textual(String mime) {
        return mime.startsWith("text/") || mime.equals("application/json") || mime.equals("application/manifest+json") || mime.equals("image/svg+xml");
    }

    private WebResourceResponse empty(int status, String reason) {
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "utf-8", status, reason, h, new ByteArrayInputStream(new byte[0]));
    }

    /** Une page ou un fichier de Synapse (app/dist dans l'APK) ; une adresse sans extension → l'application */
    private WebResourceResponse serveAsset(Uri u) {
        String path = u.getPath();
        if (path == null || path.isEmpty() || path.equals("/")) path = "/index.html";
        // pas de serveur ici : la page parle au Synapse central à son adresse à lui
        if (path.startsWith("/api/") || path.startsWith("/__")) return empty(404, "Not Found");
        if (path.contains("..") || path.contains("\\")) return empty(400, "Bad Request");
        String name = path.substring(path.lastIndexOf('/') + 1);
        if (!name.contains(".")) path = "/index.html";
        InputStream in;
        try {
            in = getAssets().open(WEB + path);
        } catch (Exception e) {
            return empty(404, "Not Found");
        }
        String mime = mimeOf(path);
        Map<String, String> h = new HashMap<>();
        boolean immutable = path.startsWith("/assets/");
        h.put("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
        h.put("X-Content-Type-Options", "nosniff");
        if (mime.equals("text/html")) h.put("Content-Security-Policy", CSP);
        return new WebResourceResponse(mime, textual(mime) ? "utf-8" : null, 200, "OK", h, in);
    }

    // ───────────────────────── réseau du téléphone (Wi-Fi ↔ 4G/5G)

    private void watchNetwork() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return;
        netCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                ui.post(() -> networkChanged(true));
            }

            @Override
            public void onLost(Network network) {
                ui.post(() -> {
                    // un autre réseau a peut-être déjà pris le relais (passage du Wi-Fi à la 4G)
                    ConnectivityManager c = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
                    networkChanged(c != null && c.getActiveNetwork() != null);
                });
            }
        };
        try {
            cm.registerDefaultNetworkCallback(netCallback);
        } catch (Exception ignored) {
            netCallback = null;
        }
    }

    private void networkChanged(boolean available) {
        if (web == null) return;
        web.evaluateJavascript("window.__synapseNetwork && window.__synapseNetwork(" + available + ")", null);
    }

    // ───────────────────────── cycle de vie

    @Override
    protected void onResume() {
        super.onResume();
        web.resumeTimers();
        web.onResume();
        web.evaluateJavascript("window.__synapseResume && window.__synapseResume()", null);
        checkUpdate();
    }

    @Override
    protected void onPause() {
        // la page garde aussitôt sa copie du cerveau (« visibilitychange »), puis tout se met en pause : pas de réseau ni
        // de batterie dépensés en arrière-plan. La synchronisation reprend dès le retour dans l'application.
        web.onPause();
        web.pauseTimers();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        ui.removeCallbacksAndMessages(null);
        if (netCallback != null) {
            try {
                ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
                if (cm != null) cm.unregisterNetworkCallback(netCallback);
            } catch (Exception ignored) {
                // déjà retiré
            }
        }
        io.shutdownNow();
        web.destroy();
        super.onDestroy();
    }

    /** Retour = Échap : ferme ce qui est ouvert dans Synapse ; sinon, l'application passe en arrière-plan */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        web.evaluateJavascript("(window.__synapseBack && window.__synapseBack()) ? 'oui' : 'non'", value -> {
            if (value == null || !value.contains("oui")) moveTaskToBack(true);
        });
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_REQUEST) {
            if (fileCallback != null) fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    // ───────────────────────── nouvelle version sur GitHub (une vérification par jour au plus)

    private void checkUpdate() {
        long now = System.currentTimeMillis();
        SharedPreferences p = Central.prefs(this);
        if (now - lastUpdateCheck < 3600_000L || now - p.getLong("maj_verifiee", 0) < 20 * 3600_000L) return;
        lastUpdateCheck = now;
        io.execute(() -> {
            String latest = Central.latestRelease();
            if (latest == null) return;
            p.edit().putLong("maj_verifiee", System.currentTimeMillis()).apply();
            if (!Central.newer(latest, BuildConfig.VERSION_NAME) || latest.equals(p.getString("maj_ignoree", ""))) return;
            ui.post(() -> {
                if (isFinishing()) return;
                new AlertDialog.Builder(this)
                        .setTitle("Nouvelle version de Synapse")
                        .setMessage("La version " + latest.replaceAll("^[vV]", "") + " est disponible (tu as la " + BuildConfig.VERSION_NAME + ").\n\n"
                                + "Télécharge-la puis installe-la par-dessus. Si Android refuse, il faut d'abord désinstaller Synapse : "
                                + "vérifie avant que tout est synchronisé (point vert à côté de ton prénom), puis reconnecte-toi après l'installation.")
                        .setPositiveButton("Télécharger", (d, w) -> openExternal("https://github.com/" + BuildConfig.DEPOT + "/releases/latest/download/Synapse.apk"))
                        .setNegativeButton("Plus tard", (d, w) -> p.edit().putString("maj_ignoree", latest).apply())
                        .show();
            });
        });
    }

    // ───────────────────────── fichiers (export de ses données)

    private boolean saveDownload(String name, String text) {
        String safe = name.replaceAll("[\\\\/:*?\"<>|]", "_");
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, safe);
                v.put(MediaStore.Downloads.MIME_TYPE, safe.endsWith(".json") ? "application/json" : "text/plain");
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) return false;
                try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                    if (out == null) return false;
                    out.write(bytes);
                }
            } else {
                File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                if (dir == null) return false;
                File f = new File(dir, safe);
                try (FileOutputStream out = new FileOutputStream(f)) {
                    out.write(bytes);
                }
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    // ───────────────────────── ce que la page peut demander à l'application

    private final class Bridge {
        @JavascriptInterface
        public String version() {
            return BuildConfig.VERSION_NAME;
        }

        /** V7 : Synapse est dans l'application (il marche sans serveur, et se synchronise quand il peut) */
        @JavascriptInterface
        public boolean standalone() {
            return true;
        }

        /** La version, et où trouver le Synapse central (le dépôt GitHub où il publie son adresse, son adresse fixe) */
        @JavascriptInterface
        public String info() {
            try {
                JSONObject j = new JSONObject();
                j.put("version", BuildConfig.VERSION_NAME);
                j.put("depot", BuildConfig.DEPOT);
                j.put("branche", BuildConfig.BRANCHE);
                j.put("fichier", BuildConfig.FICHIER);
                j.put("adresseFixe", BuildConfig.ADRESSE_FIXE);
                return j.toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public boolean saveFile(String name, String text) {
            boolean ok = saveDownload(name == null ? "synapse.json" : name, text == null ? "" : text);
            ui.post(() -> Toast.makeText(MainActivity.this, ok ? "Enregistré dans Téléchargements" : "Enregistrement impossible", Toast.LENGTH_SHORT).show());
            return ok;
        }

        @JavascriptInterface
        public void openExternal(String url) {
            if (url == null || !url.matches("(?i)^https?://.+")) return;
            ui.post(() -> MainActivity.this.openExternal(url));
        }

        /** Copier (un lien d'invitation…) dans le presse-papiers du téléphone */
        @JavascriptInterface
        public boolean copy(String text) {
            if (text == null) return false;
            ui.post(() -> {
                try {
                    ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                    if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("Synapse", text));
                } catch (Exception ignored) {
                    // presse-papiers indisponible
                }
            });
            return true;
        }

        /** Envoyer un texte (une invitation…) par le menu de partage du téléphone : WhatsApp, SMS, e-mail… */
        @JavascriptInterface
        public boolean share(String text) {
            if (text == null || text.isEmpty()) return false;
            ui.post(() -> {
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType("text/plain");
                send.putExtra(Intent.EXTRA_TEXT, text);
                send.putExtra(Intent.EXTRA_SUBJECT, "Synapse");
                try {
                    startActivity(Intent.createChooser(send, "Envoyer avec…"));
                } catch (ActivityNotFoundException e) {
                    Toast.makeText(MainActivity.this, "Aucune application pour envoyer", Toast.LENGTH_SHORT).show();
                }
            });
            return true;
        }

        /** (V6) gardés pour d'anciennes pages : la page V7 retrouve le Synapse central elle-même */
        @JavascriptInterface
        public void unreachable() {}

        @JavascriptInterface
        public void changeServer() {}
    }

    private final class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (u != null && APP_HOST.equalsIgnoreCase(u.getHost())) return serveAsset(u);
            // tout le reste (le Synapse central, GitHub) : par Internet, comme d'habitude
            return null;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (APP_HOST.equalsIgnoreCase(u.getHost())) return false;
            String scheme = String.valueOf(u.getScheme());
            // tout le reste (GitHub, liens externes, téléchargement de l'application) : dans le navigateur du téléphone
            if (scheme.equals("http") || scheme.equals("https") || scheme.equals("mailto") || scheme.equals("tel")) {
                openExternal(u.toString());
            }
            return true;
        }
    }

    private final class Chrome extends WebChromeClient {
        /** Importer des données (choisir un fichier) */
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            try {
                startActivityForResult(params.createIntent(), FILE_REQUEST);
                return true;
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                return false;
            }
        }
    }
}
