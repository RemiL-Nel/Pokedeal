package fr.remi.pokedeals;

import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KeepAlivePlugin.class);
        super.onCreate(savedInstanceState);
        try {
            WebView w = getBridge().getWebView();
            KeepAliveService.web = w;
            // garde le processus de rendu du WebView prioritaire même écran éteint / appli masquée
            if (android.os.Build.VERSION.SDK_INT >= 26) w.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        } catch (Exception ignored) {}
    }

    // Garde les timers JS actifs quand l'appli passe en arrière-plan (la surveillance en dépend)
    private void keepTimers() {
        try { WebView w = getBridge().getWebView(); if (w != null) w.resumeTimers(); } catch (Exception ignored) {}
    }
    @Override public void onPause() { super.onPause(); keepTimers(); }
    @Override public void onStop() { super.onStop(); keepTimers(); }
}
