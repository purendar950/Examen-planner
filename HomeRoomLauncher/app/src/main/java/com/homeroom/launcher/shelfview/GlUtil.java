package com.homeroom.launcher.shelfview;

import android.graphics.Bitmap;
import android.opengl.GLES20;
import android.opengl.GLUtils;
import android.util.Log;

/** OpenGL helpers: program compilation and texture upload. */
public final class GlUtil {
    private static final String TAG = "GlUtil";

    public static int compile(int type, String src) {
        int sh = GLES20.glCreateShader(type);
        GLES20.glShaderSource(sh, src);
        GLES20.glCompileShader(sh);
        int[] ok = new int[1];
        GLES20.glGetShaderiv(sh, GLES20.GL_COMPILE_STATUS, ok, 0);
        if (ok[0] == 0) {
            Log.e(TAG, "Shader compile failed: " + GLES20.glGetShaderInfoLog(sh));
            GLES20.glDeleteShader(sh);
            return 0;
        }
        return sh;
    }

    public static int program(String vs, String fs) {
        int v = compile(GLES20.GL_VERTEX_SHADER, vs);
        int f = compile(GLES20.GL_FRAGMENT_SHADER, fs);
        if (v == 0 || f == 0) return 0;
        int p = GLES20.glCreateProgram();
        GLES20.glAttachShader(p, v);
        GLES20.glAttachShader(p, f);
        GLES20.glLinkProgram(p);
        int[] ok = new int[1];
        GLES20.glGetProgramiv(p, GLES20.GL_LINK_STATUS, ok, 0);
        if (ok[0] == 0) {
            Log.e(TAG, "Program link failed: " + GLES20.glGetProgramInfoLog(p));
            GLES20.glDeleteProgram(p);
            return 0;
        }
        GLES20.glDeleteShader(v);
        GLES20.glDeleteShader(f);
        return p;
    }

    /** Upload bitmap to a new 2D texture. Caller deletes with {@link #delete(int)}. */
    public static int tex(Bitmap bmp, boolean filter) {
        int[] t = new int[1];
        GLES20.glGenTextures(1, t, 0);
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, t[0]);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER,
                filter ? GLES20.GL_LINEAR : GLES20.GL_NEAREST);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER,
                filter ? GLES20.GL_LINEAR : GLES20.GL_NEAREST);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
        GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, bmp, 0);
        return t[0];
    }

    public static void delete(int texId) {
        if (texId != 0) {
            int[] t = {texId};
            GLES20.glDeleteTextures(1, t, 0);
        }
    }

    public static void checkError(String where) {
        int e = GLES20.glGetError();
        if (e != GLES20.GL_NO_ERROR) {
            Log.e(TAG, "GL error 0x" + Integer.toHexString(e) + " at " + where);
        }
    }

    private GlUtil() {}
}
