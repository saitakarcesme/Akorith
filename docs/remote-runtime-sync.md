# Remote Runtime Sync — use the PC's Ollama from the Mac

Akorith automatically picks the **best reachable local-model endpoint** so the Mac can use
the PC's Ollama models — on the same Wi-Fi *and* away from home — without fiddling each time.

## How auto-resolution works

On launch (and when you click Auto-connect / Refresh), Akorith tries, in order, and uses the
first that answers `/api/tags`:

1. **Configured endpoint** (your local Mac Ollama, usually `http://localhost:11434`).
2. **Last successful endpoint** (cached from last time).
3. **Saved remote profiles**, by priority (e.g. the PC's LAN or Tailscale address).
4. **Akorith Controller profiles** — the PC's controller host, `host:11434`.
5. **Tailscale peers** — online devices on your tailnet, `100.x:11434`.

The active source is shown in the model-picker label and on the Dashboard
("Local", "Remote: …", "PC via Controller (…)", "PC via Tailscale (…)"). The Dashboard
**Local model runtime** card shows a readiness verdict: **Ready / Needs attention / Offline /
Setup required**.

All probes are read-only, short-timeout, and bounded — no aggressive scanning, no public
Internet probing, no secrets logged.

## Same network (same Wi-Fi)

1. On the **PC**: run Ollama bound to the LAN — start it with `OLLAMA_HOST=0.0.0.0` so other
   devices can reach `http://<pc-lan-ip>:11434` (e.g. `192.168.x.x`).
2. On the **Mac**: Settings → Providers → **Add endpoint**, enter `http://<pc-lan-ip>:11434`,
   **Test connection**, then **Auto-connect**.

A LAN IP only works while both machines are on the same network — see Tailscale for away.

## Different network (presentation away from home) — Tailscale

A Mac on another network **cannot** reach the PC's LAN IP. Use a private route:

1. Install **Tailscale** on both the PC and the Mac; sign both into the same account.
2. On the **PC**: keep it **on and awake**, run Ollama with `OLLAMA_HOST=0.0.0.0`, and keep
   Tailscale connected. (Akorith never installs Tailscale, never binds Ollama to `0.0.0.0`
   for you, and never opens firewall ports.)
3. On the **Mac**: Settings → Providers → Remote Ollama → **Find PC over Tailscale → Check
   Tailscale**. Pick your PC and **Add as endpoint**, or just click **Auto-connect** — Akorith
   discovers online tailnet peers and tries `100.x:11434` automatically.

When it connects, the model picker shows "PC via Tailscale (…)" and the Dashboard runtime
card reads **Ready**.

## With the Akorith Controller (best for GPU too)

If the PC also runs the **Akorith Controller** (Settings → API on the PC):

1. On the **Mac**: Settings → API → add a remote telemetry profile (the PC's controller URL +
   token). Token is masked, header-only, never logged.
2. Akorith derives an Ollama candidate from that host and also shows the PC's **GPU** on the
   Dashboard. Direct Ollama endpoints can't expose GPU — the controller is what enables it.

## Presentation readiness

Before a demo, open the Dashboard **Local model runtime** card and click **Refresh**:
**Ready** = endpoint reachable with models; **Needs attention** = connected but no models
(`ollama pull` one); **Offline** = a route is configured but the PC isn't reachable;
**Setup required** = nothing configured for this network.

See [`mac-to-pc-ollama.md`](mac-to-pc-ollama.md) for a step-by-step and troubleshooting.
