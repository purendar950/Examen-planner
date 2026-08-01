package com.homeroom.launcher.shelfview;

/** GLSL ES 2.0 shader sources used by the shelf renderer. */
public final class Shaders {

    public static final String VS_TEX =
            "uniform mat4 uMVP;\n" +
            "attribute vec4 aPos;\n" +
            "attribute vec2 aTex;\n" +
            "varying vec2 vTex;\n" +
            "void main() {\n" +
            "    gl_Position = uMVP * aPos;\n" +
            "    vTex = aTex;\n" +
            "}\n";

    public static final String FS_TEX_NORMAL =
            "precision mediump float;\n" +
            "varying vec2 vTex;\n" +
            "uniform sampler2D uTex;\n" +
            "uniform vec4 uTint;\n" +
            "void main() {\n" +
            "    gl_FragColor = texture2D(uTex, vTex) * uTint;\n" +
            "}\n";

    public static final String FS_TEX_GRAY =
            "precision mediump float;\n" +
            "varying vec2 vTex;\n" +
            "uniform sampler2D uTex;\n" +
            "uniform vec4 uTint;\n" +
            "void main() {\n" +
            "    vec4 c = texture2D(uTex, vTex);\n" +
            "    float g = dot(c.rgb, vec3(0.299, 0.587, 0.114));\n" +
            "    gl_FragColor = vec4(vec3(g), c.a) * uTint;\n" +
            "}\n";

    public static final String FS_TEX_ADD =
            "precision mediump float;\n" +
            "varying vec2 vTex;\n" +
            "uniform sampler2D uTex;\n" +
            "void main() {\n" +
            "    vec4 c = texture2D(uTex, vTex);\n" +
            "    gl_FragColor = vec4(c.rgb * c.a, c.a);\n" +
            "}\n";

    public static final String VS_COLOR =
            "uniform mat4 uMVP;\n" +
            "attribute vec4 aPos;\n" +
            "void main() {\n" +
            "    gl_Position = uMVP * aPos;\n" +
            "}\n";

    public static final String FS_COLOR =
            "precision mediump float;\n" +
            "uniform vec4 uColor;\n" +
            "void main() {\n" +
            "    gl_FragColor = uColor;\n" +
            "}\n";

    private Shaders() {}
}
