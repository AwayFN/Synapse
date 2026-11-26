package io.github.awayfn.synapse;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
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
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Synapse pour Android : l'application ouvre le Synapse central (le même que sur le PC) dans une vue web.
 * On s'y crée un compte (ou on s'y connecte) une fois ; on reste connecté jusqu'à « Se déconnecter ».
 * Tout ce qu'on fait ici apparaît en direct sur le PC, et l'inverse.
 *
 *  - L'adresse du serveur peut changer : l'application la retrouve sur GitHub (Central.java) et garde la session
 *    (le cookie de session est recopié pour la nouvelle adresse) : pas besoin de se reconnecter.
 *  - Le réseau du téléphone change (Wi-Fi ↔ 4G/5G) : la page est prévenue et se rebranche aussitôt.
 *  - Le bouton retour fait comme la touche Échap (ferme ce qui est ouvert) ; s'il n'y a plus rien à fermer,
 *    l'application passe en arrière-plan.
 */
public class MainActivity extends Activity {
    private static final String LOCAL_PAGE = "file:///android_asset/connexion.html";
    private static final String SESSION_COOKIE = "synapse_a";
    private static final int FILE_REQUEST = 41;
    private static final long RETRY_MS = 8000;

    private WebView web;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private ConnectivityManager.NetworkCallback netCallback;
    private ValueCallback<Uri[]> fileCallback;

    /** l'adresse du Synapse central ouverte en ce moment (https://…), ou null */
    private volatile String server;
    /** la page locale (démarrage, serveur injoignable) est affichée */
    private volatile boolean onLocalPage = true;
    private volatile boolean resolving = false;
    private volatile String lastError = "";
    private long lastResolve = 0;
    private long lastUpdateCheck = 0;
    private final Runnable retry = this::resolveAndOpen;

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
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        // le serveur reconnaît l'application (et l'espace admin la compte comme « application Android »)
        s.setUserAgentString(s.getUserAgentString() + " SynapseAndroid/" + BuildConfig.VERSION_NAME);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, false);

        web.addJavascriptInterface(new Bridge(), "SynapseAndroid");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> openExternal(url));

        // la page de connexion vient de l'application elle-même (file:///android_asset, toujours permis)
        showLocal("demarrage");
        resolveAndOpen();
        watchNetwork();
    }

    // ───────────────────────── trouver et ouvrir le Synapse central

    private void showLocal(String state) {
        onLocalPage = true;
        web.loadUrl(LOCAL_PAGE + "#" + state);
    }

    /** Cherche le serveur (hors du fil principal), puis l'ouvre ; sinon la page « injoignable », et on réessaie */
    private void resolveAndOpen() {
        ui.removeCallbacks(retry);
        if (resolving) return;
        resolving = true;
        lastResolve = System.currentTimeMillis();
        io.execute(() -> {
            String found = Central.resolve(getApplicationContext());
            ui.post(() -> {
                resolving = false;
                if (isFinishing()) return;
                if (found != null) {
                    lastError = "";
                    open(found);
                } else {
                    lastError = "Le Synapse central ne répond pas pour l’instant : l’ordinateur qui l’héberge est peut-être éteint, ou le téléphone n’a pas de réseau.";
                    if (onLocalPage) {
                        web.evaluateJavascript("window.etat && window.etat('hors-ligne')", null);
                        ui.postDelayed(retry, RETRY_MS);
                    } else {
                        // la page de Synapse est ouverte : elle se reconnecte toute seule si le serveur revient
                        ui.postDelayed(retry, RETRY_MS * 2);
                    }
                }
            });
        });
    }

    /** Ouvre le Synapse central à cette adresse, en gardant la session (même si l'adresse a changé) */
    private void open(String base) {
        boolean sameServer = base.equals(server) && !onLocalPage;
        if (sameServer) return;
        carrySession(base);
        server = base;
        onLocalPage = false;
        web.loadUrl(base + "/");
    }

    /** La session (cookie) suit le compte d'une adresse à l'autre : pas besoin de se reconnecter */
    private void carrySession(String base) {
        SharedPreferences p = Central.prefs(this);
        String token = p.getString(Central.KEY_TOKEN, null);
        if (token == null) return;
        Uri u = Uri.parse(base);
        String host = u.getHost();
        if (host == null) return;
        String existing = readSession(base);
        if (token.equals(existing)) return;
        boolean https = "https".equalsIgnoreCase(u.getScheme());
        CookieManager.getInstance().setCookie(base, SESSION_COOKIE + "=" + token + "; Path=/; Max-Age=34560000; HttpOnly; SameSite=Strict" + (https ? "; Secure" : ""));
        CookieManager.getInstance().flush();
    }

    private static String readSession(String url) {
        String all = CookieManager.getInstance().getCookie(url);
        if (all == null) return null;
        for (String part : all.split(";")) {
            String c = part.trim();
            if (c.startsWith(SESSION_COOKIE + "=")) return c.substring(SESSION_COOKIE.length() + 1);
        }
        return null;
    }

    /** Après chaque page du serveur : on retient la session (ou on l'oublie après « Se déconnecter ») */
    private void rememberSession(String url) {
        String base = server;
        if (base == null || url == null || !url.startsWith(base)) return;
        String token = readSession(base);
        SharedPreferences.Editor e = Central.prefs(this).edit();
        if (token != null && !token.isEmpty()) e.putString(Central.KEY_TOKEN, token).putString(Central.KEY_TOKEN_HOST, Uri.parse(base).getHost());
        else e.remove(Central.KEY_TOKEN).remove(Central.KEY_TOKEN_HOST);
        e.apply();
        CookieManager.getInstance().flush();
    }

    private boolean isServerUrl(Uri u) {
        String base = server;
        if (base == null || u == null) return false;
        Uri b = Uri.parse(base);
        return u.getHost() != null && u.getHost().equalsIgnoreCase(b.getHost()) && u.getPort() == b.getPort() && String.valueOf(u.getScheme()).equalsIgnoreCase(b.getScheme());
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
        if (onLocalPage) {
            if (available) resolveAndOpen();
            return;
        }
        web.evaluateJavascript("window.__synapseNetwork && window.__synapseNetwork(" + available + ")", null);
    }

    // ───────────────────────── cycle de vie

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        if (onLocalPage) {
            if (System.currentTimeMillis() - lastResolve > 4000) resolveAndOpen();
        } else {
            web.evaluateJavascript("window.__synapseResume && window.__synapseResume()", null);
        }
        checkUpdate();
    }

    @Override
    protected void onPause() {
        CookieManager.getInstance().flush();
        web.onPause();
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
        if (onLocalPage) {
            moveTaskToBack(true);
            return;
        }
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
                                + "Télécharge-la puis installe-la. Si Android refuse de l’installer par-dessus, désinstalle d’abord Synapse : ton compte et tes données sont sur le serveur, rien n’est perdu.")
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

        /** Le serveur ne répond plus depuis un moment : son adresse a peut-être changé, on la cherche */
        @JavascriptInterface
        public void unreachable() {
            ui.post(() -> {
                if (System.currentTimeMillis() - lastResolve > 15000) resolveAndOpen();
            });
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

        /** Revenir à l'écran de connexion (choisir un autre serveur) */
        @JavascriptInterface
        public void changeServer() {
            ui.post(() -> showLocal("adresse"));
        }

        // ── seulement pour la page locale (démarrage, serveur injoignable)

        @JavascriptInterface
        public String info() {
            try {
                JSONObject j = new JSONObject();
                SharedPreferences p = Central.prefs(MainActivity.this);
                j.put("version", BuildConfig.VERSION_NAME);
                j.put("depot", BuildConfig.DEPOT);
                j.put("derniere", p.getString(Central.KEY_LAST, ""));
                j.put("manuelle", p.getString(Central.KEY_MANUAL, ""));
                j.put("erreur", lastError);
                j.put("recherche", resolving);
                return j.toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public void retry() {
            ui.post(MainActivity.this::resolveAndOpen);
        }

        /** Une adresse choisie à la main (vide : revenir à l'adresse publiée par le Synapse central) */
        @JavascriptInterface
        public void setServer(String address) {
            if (!onLocalPage) return;
            String a = Central.clean(address);
            SharedPreferences.Editor e = Central.prefs(MainActivity.this).edit();
            if (a == null) e.remove(Central.KEY_MANUAL);
            else e.putString(Central.KEY_MANUAL, a);
            e.apply();
            ui.post(() -> {
                server = null;
                resolveAndOpen();
            });
        }
    }

    private final class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            String scheme = String.valueOf(u.getScheme());
            if (scheme.equals("file")) return false;
            if (isServerUrl(u)) return false;
            // tout le reste (GitHub, liens externes, téléchargement de l'application) : dans le navigateur du téléphone
            if (scheme.equals("http") || scheme.equals("https") || scheme.equals("mailto") || scheme.equals("tel")) {
                openExternal(u.toString());
                return true;
            }
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            onLocalPage = url != null && url.startsWith(LOCAL_PAGE);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (url != null && !url.startsWith(LOCAL_PAGE)) rememberSession(url);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            // le serveur ne répond pas (éteint, nouvelle adresse, pas de réseau) : page d'attente, et on cherche
            lastError = "Le Synapse central ne répond pas pour l’instant.";
            showLocal("hors-ligne");
            ui.postDelayed(MainActivity.this::resolveAndOpen, 600);
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (!request.isForMainFrame()) return;
            int code = response.getStatusCode();
            // tunnel fermé (530), passerelle sans serveur derrière : l'adresse a peut-être changé
            if (code == 530 || code == 502 || code == 504 || code == 521 || code == 523) {
                lastError = "Le Synapse central ne répond pas pour l’instant.";
                showLocal("hors-ligne");
                ui.postDelayed(MainActivity.this::resolveAndOpen, 600);
            }
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
