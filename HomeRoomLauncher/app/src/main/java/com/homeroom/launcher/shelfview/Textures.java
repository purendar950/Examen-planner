package com.homeroom.launcher.shelfview;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.RadialGradient;
import android.graphics.RectF;
import android.graphics.Shader;

import java.util.Random;

/** Bitmap generators: wood, wall, floor, shadows, lights. */
public final class Textures {

    public static Bitmap wood(int w, int h) {
        Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);

        // Base vertical wood gradient
        Paint base = new Paint();
        base.setShader(new LinearGradient(0, 0, w, 0,
                new int[]{0xFFB98D5F, 0xFFCFA675, 0xFFB98D5F},
                null, Shader.TileMode.CLAMP));
        c.drawRect(0, 0, w, h, base);

        // Horizontal grain streaks
        Random rnd = new Random(7 + w * 31 + h);
        Paint grain = new Paint();
        grain.setAntiAlias(true);
        for (int i = 0; i < 90; i++) {
            float y = rnd.nextFloat() * h;
            float thick = 0.5f + rnd.nextFloat() * 2.0f;
            int alpha = 10 + rnd.nextInt(34);
            grain.setColor(Color.argb(alpha, 90, 60, 30));
            grain.setStrokeWidth(thick);
            float wobble = (rnd.nextFloat() - 0.5f) * 24f;
            c.drawLine(-10, y, w * 0.5f + wobble, y + (rnd.nextFloat() - 0.5f) * 8f, grain);
            c.drawLine(w * 0.5f + wobble, y + (rnd.nextFloat() - 0.5f) * 8f,
                    w + 10, y, grain);
        }

        // Top highlight & bottom shade for plank feel
        Paint edge = new Paint();
        edge.setShader(new LinearGradient(0, 0, 0, h,
                new int[]{0x55FFFFFF, 0x00000000, 0x33000000},
                new float[]{0f, 0.35f, 1f}, Shader.TileMode.CLAMP));
        c.drawRect(0, 0, w, h, edge);
        return bmp;
    }

    public static Bitmap wall(int w, int h) {
        Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        Paint p = new Paint();
        p.setShader(new LinearGradient(0, 0, 0, h,
                new int[]{0xFF3A3F4A, 0xFF2E333D, 0xFF262A33},
                null, Shader.TileMode.CLAMP));
        c.drawRect(0, 0, w, h, p);

        // Subtle vignette
        Paint v = new Paint();
        v.setShader(new RadialGradient(w / 2f, h * 0.42f, Math.max(w, h) * 0.75f,
                0x00000000, 0x66000000, Shader.TileMode.CLAMP));
        c.drawRect(0, 0, w, h, v);
        return bmp;
    }

    public static Bitmap floor(int w, int h) {
        Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        Paint p = new Paint();
        p.setShader(new LinearGradient(0, 0, 0, h,
                new int[]{0xFF1C1F26, 0xFF15181D},
                null, Shader.TileMode.CLAMP));
        c.drawRect(0, 0, w, h, p);

        // Faint sheen where the light hits
        Paint s = new Paint();
        s.setAntiAlias(true);
        s.setShader(new RadialGradient(w / 2f, h * 0.1f, w * 0.7f,
                0x33FFF2CC, 0x00000000, Shader.TileMode.CLAMP));
        c.drawOval(new RectF(-w * 0.2f, -h * 0.4f, w * 1.2f, h * 0.8f), s);
        return bmp;
    }

    public static Bitmap circleShadow(int size) {
        Bitmap bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        Paint p = new Paint();
        p.setAntiAlias(true);
        p.setShader(new RadialGradient(size / 2f, size / 2f, size / 2f,
                0xAA000000, 0x00000000, Shader.TileMode.CLAMP));
        c.drawRect(0, 0, size, size, p);
        return bmp;
    }

    public static Bitmap rectShadow(int w, int h, float edge) {
        Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        Paint p = new Paint();
        p.setAntiAlias(true);
        // Layer a few soft-edged rounded rects
        for (int i = 6; i > 0; i--) {
            float pad = edge * i / 6f;
            int alpha = (int) (18f * i);
            p.setColor(Color.argb(Math.min(alpha, 120), 0, 0, 0));
            c.drawRoundRect(new RectF(pad, pad, w - pad, h - pad), 24, 24, p);
        }
        return bmp;
    }

    public static Bitmap halo(int size) {
        Bitmap bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        Paint p = new Paint();
        p.setAntiAlias(true);
        p.setShader(new RadialGradient(size / 2f, size / 2f, size / 2f,
                new int[]{0x00FFFFFF, 0x44FFFFFF, 0x22FFFFFF, 0x00FFFFFF},
                new float[]{0f, 0.55f, 0.78f, 1f}, Shader.TileMode.CLAMP));
        c.drawRect(0, 0, size, size, p);
        return bmp;
    }

    public static Bitmap beam(int size) {
        // Alpha gradient that fades downward sampled with vTex.y (1 at top).
        Bitmap bmp = Bitmap.createBitmap(4, size, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        Paint p = new Paint();
        p.setShader(new LinearGradient(0, 0, 0, size,
                new int[]{0x2BFFFFFF, 0x14FFFFFF, 0x00FFFFFF},
                null, Shader.TileMode.CLAMP));
        c.drawRect(0, 0, 4, size, p);
        return bmp;
    }

    public static Bitmap pendantShade(int w, int h) {
        Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        Paint p = new Paint();
        p.setAntiAlias(true);
        p.setShader(new LinearGradient(0, 0, 0, h,
                new int[]{0xFF33373F, 0xFF1F2228},
                null, Shader.TileMode.CLAMP));
        p.setStyle(Paint.Style.FILL);
        // Trapezoid shade
        android.graphics.Path path = new android.graphics.Path();
        path.moveTo(w * 0.34f, 0);
        path.lineTo(w * 0.66f, 0);
        path.lineTo(w * 0.88f, h * 0.92f);
        path.quadTo(w / 2f, h * 1.08f, w * 0.12f, h * 0.92f);
        path.close();
        c.drawPath(path, p);

        // Rim light bottom edge
        Paint rim = new Paint();
        rim.setAntiAlias(true);
        rim.setStyle(Paint.Style.STROKE);
        rim.setStrokeWidth(h * 0.06f);
        rim.setColor(0xCCFFD9A0);
        c.drawArc(new RectF(w * 0.12f, h * 0.72f, w * 0.88f, h * 1.12f), 20, 140, false, rim);
        return bmp;
    }

    private Textures() {}
}
