package com.homeroom.launcher.shelfview;

import android.content.Context;
import android.content.SharedPreferences;

/** Persists which package lives in which shelf slot. */
public final class Slots {
    private static final String PREFS = "slots";
    public static final int ROWS = 3;
    public static final int COLS = 4;
    public static final int COUNT = ROWS * COLS;

    private final SharedPreferences prefs;

    public Slots(Context ctx) {
        prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public String get(int slot) {
        return prefs.getString("slot_" + slot, null);
    }

    public void set(int slot, String pkg) {
        if (pkg == null) {
            prefs.edit().remove("slot_" + slot).apply();
        } else {
            prefs.edit().putString("slot_" + slot, pkg).apply();
        }
    }

    public void clear(int slot) {
        set(slot, null);
    }
}
