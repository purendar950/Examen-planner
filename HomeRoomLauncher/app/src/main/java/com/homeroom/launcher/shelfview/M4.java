package com.homeroom.launcher.shelfview;

import android.opengl.Matrix;

/** Small wrapper so renderer code stays readable. */
public final class M4 {
    public final float[] m = new float[16];

    public M4() {
        Matrix.setIdentityM(m, 0);
    }

    public static M4 multiply(float[] a, float[] b) {
        M4 r = new M4();
        Matrix.multiplyMM(r.m, 0, a, 0, b, 0);
        return r;
    }

    public static M4 ortho(float l, float r, float b, float t, float n, float f) {
        M4 o = new M4();
        Matrix.orthoM(o.m, 0, l, r, b, t, n, f);
        return o;
    }

    public static M4 identity() {
        return new M4();
    }
}
