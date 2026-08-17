package com.homeroom.launcher.shelfview;

import java.util.Random;

/**
 * Stub-like physics used for icon "life": springs, sway, barges, gentle drift.
 * All state is deterministic on a per-icon seed so long-press "wiggle" is stable.
 */
public final class Physics {

    public static final class Spring {
        public float value, target, velocity;
        private final float stiffness, damping;

        public Spring(float stiffness, float damping) {
            this.stiffness = stiffness;
            this.damping = damping;
        }

        public void update(float dt) {
            // Semi-implicit Euler on a damped spring toward target
            float force = (target - value) * stiffness;
            velocity += force * dt;
            velocity *= Math.exp(-damping * dt);
            value += velocity * dt;
        }
    }

    public static final class IconLife {
        private final long seed;
        public float swayPhase, swaySpeed, swayAmp;
        public float bobPhase, bobSpeed, bobAmp;
        public float rotPhase, rotSpeed, rotAmp;
        public float breatheSpeed, breatheAmp, breathePhase;

        public IconLife(long seed) {
            this.seed = seed;
            Random r = new Random(seed);
            swayAmp = 0.008f + r.nextFloat() * 0.02f;
            swaySpeed = 0.7f + r.nextFloat() * 1.1f;
            swayPhase = r.nextFloat() * (float) Math.PI * 2;
            bobAmp = 0.005f + r.nextFloat() * 0.01f;
            bobSpeed = 0.5f + r.nextFloat() * 0.9f;
            bobPhase = r.nextFloat() * (float) Math.PI * 2;
            rotAmp = 0.002f + r.nextFloat() * 0.006f;
            rotSpeed = 0.3f + r.nextFloat() * 0.5f;
            rotPhase = r.nextFloat() * (float) Math.PI * 2;
            breatheAmp = 0.0f;
            breatheSpeed = 1.2f;
            breathePhase = r.nextFloat() * (float) Math.PI * 2;
        }

        /** Applies a small "barge" impulse (e.g., user tapped a neighbour). */
        public void barge(Spring offset, float dir) {
            offset.velocity += dir * (0.4f + Math.abs(swayAmp) * 10f);
        }
    }

    /** Detects when two floating icons get close and nudges them apart. */
    public static void collide(Spring[] offsets, int a, int b, float dirSign) {
        offsets[a].velocity -= dirSign * 0.18f;
        offsets[b].velocity += dirSign * 0.18f;
    }

    private Physics() {}
}
