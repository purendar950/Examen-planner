package com.homeroom.launcher.shelfview;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.AdaptiveIconDrawable;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.Drawable;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/** Loads launchable apps and rasterises their icons to Bitmaps. */
public final class IconCache {

    public static final class Entry {
        public final String packageName;
        public final String label;
        public final Drawable icon;

        Entry(String pkg, String label, Drawable icon) {
            this.packageName = pkg;
            this.label = label;
            this.icon = icon;
        }
    }

    private static List<Entry> cached;

    public static synchronized List<Entry> getLaunchables(Context ctx) {
        if (cached != null) return cached;

        PackageManager pm = ctx.getPackageManager();
        Intent i = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> infos = pm.queryIntentActivities(i, 0);

        List<Entry> out = new ArrayList<>();
        for (ResolveInfo ri : infos) {
            String pkg = ri.activityInfo.packageName;
            String label = ri.loadLabel(pm).toString();
            Drawable icon = ri.loadIcon(pm);
            out.add(new Entry(pkg, label, icon));
        }

        // De-duplicate packages (keep first label/icon)
        List<Entry> dedup = new ArrayList<>();
        String last = null;
        Collections.sort(out, new Comparator<Entry>() {
            @Override public int compare(Entry a, Entry b) {
                return a.packageName.compareTo(b.packageName);
            }
        });
        for (Entry e : out) {
            if (!e.packageName.equals(last)) {
                dedup.add(e);
                last = e.packageName;
            }
        }

        // Now sort by label for browsing
        Collections.sort(dedup, new Comparator<Entry>() {
            @Override public int compare(Entry a, Entry b) {
                return a.label.compareToIgnoreCase(b.label);
            }
        });

        cached = dedup;
        return cached;
    }

    /** Rasterise a Drawable into a Bitmap at the requested pixel size. */
    public static Bitmap toBitmap(Drawable d, int size) {
        Bitmap bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        if (d instanceof BitmapDrawable) {
            d.setBounds(0, 0, size, size);
            d.draw(c);
        } else if (d instanceof AdaptiveIconDrawable) {
            d.setBounds(0, 0, size, size);
            d.draw(c);
        } else {
            d.setBounds(0, 0, size, size);
            d.draw(c);
        }
        return bmp;
    }

    /** Find a specific package's icon, or null if unavailable. */
    public static Entry findByPackage(Context ctx, String pkg) {
        for (Entry e : getLaunchables(ctx)) {
            if (e.packageName.equals(pkg)) return e;
        }
        return null;
    }
}
