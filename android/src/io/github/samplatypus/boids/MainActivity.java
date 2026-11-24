package io.github.samplatypus.boids;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.webkit.ValueCallback;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;

/**
 * Boids for Android: shows the self-contained app (assets/index.html, a copy
 * of dist/boids.html) full screen in a WebView.
 *
 * Nothing here touches the network. The manifest requests no permissions (so
 * Android blocks all network access), network loads are blocked in the
 * WebView as well, any request for a non-bundled URL gets an empty response,
 * and the page can never navigate away.
 */
public final class MainActivity extends Activity {
    private static final String APP = "file:///android_asset/index.html";
    private static final int BACKGROUND = Color.rgb(0x04, 0x0d, 0x1a);

    private WebView web;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        web.setBackgroundColor(BACKGROUND);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true); // settings persist on the device (localStorage)
        settings.setBlockNetworkLoads(true);
        settings.setBlockNetworkImage(true);
        settings.setAllowFileAccess(false); // bundled assets stay readable via file:///android_asset
        settings.setAllowContentAccess(false);
        settings.setGeolocationEnabled(false);
        settings.setSaveFormData(false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return true; // never navigate anywhere
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
                if (url.startsWith("file:///android_asset/")) return null; // the bundled app
                return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
            }
        });

        // Long presses belong to the simulation (beacons), not to text selection menus.
        web.setLongClickable(false);
        web.setHapticFeedbackEnabled(false);
        web.setOnLongClickListener(new View.OnLongClickListener() {
            @Override
            public boolean onLongClick(View view) {
                return true;
            }
        });

        setContentView(web);
        web.loadUrl(APP);
    }

    /** Back closes the controls drawer if it is open, otherwise leaves the app. */
    @Override
    public void onBackPressed() {
        web.evaluateJavascript(
                "(function(){var h=window.boidsHud;if(h&&h.isOpen()){h.close();return 'closed'}return 'none'})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if (!"\"closed\"".equals(value)) moveTaskToBack(true);
                    }
                });
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();
        web.pauseTimers();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.resumeTimers();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}
