package fr.remi.pokedeals;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.webkit.WebView;

/** Service de premier plan : garde le processus (et donc la surveillance JS) vivant écran éteint. */
public class KeepAliveService extends Service {
    private static final String CH = "pd_keepalive";
    private PowerManager.WakeLock wl;
    /** WebView de l'appli (posé par MainActivity) */
    public static volatile WebView web;
    private final Handler h = new Handler(Looper.getMainLooper());
    private final Runnable beat = new Runnable() {
        @Override public void run() {
            try { WebView w = web; if (w != null) { w.resumeTimers(); w.evaluateJavascript("window.pdPoke&&window.pdPoke()", null); } } catch (Exception ignored) {}
            h.postDelayed(this, 20000);
        }
    };
    private boolean beating = false;

    @Override public IBinder onBind(Intent i) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(CH, "Surveillance en arrière-plan", NotificationManager.IMPORTANCE_LOW));
        }
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CH) : new Notification.Builder(this);
        Notification n = b.setContentTitle("PokéDeals surveille Vinted")
            .setContentText("Les bonnes affaires seront notifiées")
            .setSmallIcon(getApplicationInfo().icon)
            .setOngoing(true).setContentIntent(pi).build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(7001, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(7001, n);
        if (wl == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "pokedeals:watch");
            wl.setReferenceCounted(false);
            wl.acquire();
        }
        if (!beating) { beating = true; h.postDelayed(beat, 20000); }
        return START_STICKY;
    }

    @Override public void onDestroy() {
        h.removeCallbacks(beat); beating = false;
        if (wl != null && wl.isHeld()) wl.release();
        wl = null;
        super.onDestroy();
    }
}
