package io.github.awayfn.synapse;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Log;
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

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Calendar;
import java.util.HashMap;
import java.util.Map;

/**
 * Synapse pour Android (V8) : 100 % local. Synapse est DANS l'application et marche sans réseau ; l'application n'a
 * même pas la permission d'accéder à Internet. Pas de compte, pas de serveur : un appui sur l'icône ouvre ton réseau.
 *
 *  - Les pages de Synapse (app/dist, copiées dans l'APK) sont servies par l'application elle-même, à l'adresse réservée
 *    https://appassets.androidplatform.net (jamais demandée sur Internet). Tout le reste est refusé.
 *  - Les données sont gardées dans le téléphone (stockage de la page), avec une copie de sauvegarde automatique dans
 *    Documents/Synapse (une par jour de la semaine) : elle reste même si l'application est désinstallée.
 *  - Exporter enregistre un fichier dans Téléchargements ; importer ouvre le sélecteur de fichiers du téléphone.
 *  - Le bouton retour fait comme la touche Échap (ferme ce qui est ouvert) ; s'il n'y a plus rien à fermer,
 *    l'application passe en arrière-plan.
 */
public class MainActivity extends Activity {
    static final String TAG = "Synapse";
    static final String APP_HOST = "appassets.androidplatform.net";
    private static final String APP_URL = "https://" + APP_HOST + "/";
    private static final String WEB = "web";
    private static final int FILE_REQUEST = 41;
    /** Les pages de Synapse ne parlent qu'à elles-mêmes */
    private static final String CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
            + "font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'";
    private static final String[] JOURS = {"dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"};

    private WebView web;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private ValueCallback<Uri[]> fileCallback;

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
        // ton réseau, gardé dans le téléphone (la page l'écrit dans son stockage local)
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
        s.setGeolocationEnabled(false);
        // rien ne vient d'Internet (l'application n'en a pas la permission, et tout le reste est refusé ci-dessous)
        s.setBlockNetworkLoads(true);
        s.setUserAgentString(s.getUserAgentString() + " SynapseAndroid/" + BuildConfig.VERSION_NAME);

        web.addJavascriptInterface(new Bridge(), "SynapseAndroid");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());

        if (state != null) web.restoreState(state);
        if (web.getUrl() == null) web.loadUrl(APP_URL);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    // ───────────────────────── les pages de Synapse, depuis l'APK

    private static String mimeOf(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
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
        return mime.startsWith("text/") || mime.equals("application/json") || mime.equals("image/svg+xml");
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

    // ───────────────────────── cycle de vie

    @Override
    protected void onResume() {
        super.onResume();
        web.resumeTimers();
        web.onResume();
    }

    @Override
    protected void onPause() {
        // la page garde aussitôt ses données (« visibilitychange »), puis tout se met en pause
        web.onPause();
        web.pauseTimers();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        ui.removeCallbacksAndMessages(null);
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

    // ───────────────────────── fichiers : export (Téléchargements), sauvegarde automatique (Documents/Synapse)

    private static String safeName(String name) {
        return name.replaceAll("[\\\\/:*?\"<>|]", "_");
    }

    private boolean saveDownload(String name, String text) {
        String safe = safeName(name);
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
                try (FileOutputStream out = new FileOutputStream(new File(dir, safe))) {
                    out.write(bytes);
                }
            }
            return true;
        } catch (Exception e) {
            Log.w(TAG, "export impossible", e);
            return false;
        }
    }

    /**
     * La sauvegarde du jour (une par jour de la semaine : synapse-lundi.json…) dans Documents/Synapse. Elle reste dans le
     * téléphone même si Synapse est désinstallé : après une réinstallation, « Importer » la retrouve. (Android 10 et plus.)
     */
    private boolean saveBackup(String text) {
        if (Build.VERSION.SDK_INT < 29) return false;
        String name = "synapse-" + JOURS[Calendar.getInstance().get(Calendar.DAY_OF_WEEK) - 1] + ".json";
        String folder = Environment.DIRECTORY_DOCUMENTS + "/Synapse/";
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        ContentResolver cr = getContentResolver();
        Uri collection = MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        try {
            Uri uri = null;
            // le fichier de ce jour, s'il a déjà été écrit par cette installation de Synapse
            try (Cursor c = cr.query(collection, new String[]{MediaStore.MediaColumns._ID},
                    MediaStore.MediaColumns.RELATIVE_PATH + "=? AND " + MediaStore.MediaColumns.DISPLAY_NAME + "=?",
                    new String[]{folder, name}, null)) {
                if (c != null && c.moveToFirst()) uri = ContentUris.withAppendedId(collection, c.getLong(0));
            }
            if (uri == null) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                v.put(MediaStore.MediaColumns.MIME_TYPE, "application/json");
                v.put(MediaStore.MediaColumns.RELATIVE_PATH, folder);
                uri = cr.insert(collection, v);
            }
            if (uri == null) return false;
            try (OutputStream out = cr.openOutputStream(uri, "wt")) {
                if (out == null) return false;
                out.write(bytes);
            }
            return true;
        } catch (Exception e) {
            Log.w(TAG, "sauvegarde impossible", e);
            return false;
        }
    }

    // ───────────────────────── ce que la page peut demander à l'application

    private final class Bridge {
        @JavascriptInterface
        public String version() {
            return BuildConfig.VERSION_NAME;
        }

        @JavascriptInterface
        public boolean saveFile(String name, String text) {
            boolean ok = saveDownload(name == null ? "synapse.json" : name, text == null ? "" : text);
            ui.post(() -> Toast.makeText(MainActivity.this, ok ? "Enregistré dans Téléchargements" : "Enregistrement impossible", Toast.LENGTH_SHORT).show());
            return ok;
        }

        @JavascriptInterface
        public boolean backup(String text) {
            if (text == null || text.isEmpty()) return false;
            return saveBackup(text);
        }
    }

    private final class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (u != null && "https".equals(u.getScheme()) && APP_HOST.equalsIgnoreCase(u.getHost())) return serveAsset(u);
            // 100 % local : rien d'autre, jamais
            return empty(403, "Forbidden");
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            // Synapse reste chez lui : aucune autre page ne s'ouvre
            return !(u != null && APP_HOST.equalsIgnoreCase(u.getHost()));
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            // un signe de vie dans le journal du téléphone (sert aux essais de construction) : la page a démarré
            ui.postDelayed(() -> {
                if (web == null) return;
                web.evaluateJavascript("(document.querySelector('[data-view-tab]') ? 'interface' : 'vide') + '|' + document.querySelectorAll('[data-label-id]').length + '|' + (document.querySelector('[data-no-scene]') ? 'sans3d' : '3d')",
                        value -> Log.i(TAG, "page prete : " + value));
            }, 6000);
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
