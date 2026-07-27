# ControlD DNS — YouTube Ad Block Setup Guide

> Block YouTube ads at the **DNS level** using ControlD custom resolvers. Works alongside the `youtube-turbo-proxy` for a layered ad-free experience on all devices.

---

## How It Works

ControlD DNS resolvers filter ad/tracking domains **before** they ever reach your device. When a YouTube video tries to load an ad, the DNS query for the ad server is blocked — the ad simply never loads.

| Layer | What it does | Where |
|-------|-------------|-------|
| **ControlD DNS** (this guide) | Blocks ad DNS queries network-wide | Router / Device DNS settings |
| **Turbo Proxy** (`youtube-turbo-proxy/`) | Proxies video streams, bypasses 2x speed cap | Your Render backend |

Using **both** together gives the best experience: DNS blocks most ads, and the proxy handles any that slip through plus gives you 4x playback speed.

---

## Platform-Specific Setup

### Android (Private DNS)

1. Go to **Settings → Network & Internet → Private DNS**.
2. Select **Private DNS provider hostname**.
3. Enter the DoT hostname from the admin DNS panel.
4. Tap **Save**.

### iOS

1. Download the **Controld** app from the App Store.
2. Enter the Resolver ID from the admin DNS panel.
3. Enable the DNS profile.

### Chrome (Desktop)

1. Go to `chrome://settings/security`.
2. Enable **Use secure DNS** → **With Custom**.
3. Enter the DoH URL from the admin DNS panel.
4. Relaunch Chrome.

### Windows

1. Go to **Settings → Network & Internet → DNS server assignment**.
2. Set DNS to **Manual**.
3. Enter `76.76.2.0` and `76.76.10.0` as primary/secondary.
4. Set DoH template URL from the admin DNS panel.

### Android TV

1. Go to **Settings → Network → Wi-Fi → Modify network**.
2. Expand **Advanced options** → set DNS 1: `76.76.2.0`, DNS 2: `76.76.10.0`.

### Router-Level (All Devices)

1. Log into your router admin panel.
2. Set primary DNS to `76.76.2.0`, secondary to `76.76.10.0`.
3. Save and reboot.

---

## Verification

```bash
nslookup -type=TXT debug.controld.com
```
Or visit [controld.com/p1](https://dns.controld.com/p1) to confirm your resolver is active.

---

## Integration with PrepPath

The PrepPath app uses `youtube-turbo-proxy` for ad-free playback in Turbo mode. DNS adblocking complements it by blocking ads network-wide across all apps and devices.

**Recommendation:** Use both for maximum ad-free coverage.
