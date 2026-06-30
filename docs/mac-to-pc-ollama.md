# Mac → PC Ollama: step-by-step + troubleshooting

Goal: the Mac shows and uses the PC's Ollama models, at home and away. See
[`remote-runtime-sync.md`](remote-runtime-sync.md) for the architecture.

## PC (the machine with the GPU + models)

- Keep it **on and awake** while you need it (disable sleep, or "stay awake on AC").
- Run Ollama reachable beyond localhost: set `OLLAMA_HOST=0.0.0.0` and (re)start Ollama.
- Pull at least one model: `ollama pull llama3.1` (or your choice).
- **Away from home:** install Tailscale and sign in; keep it connected.
- **Optional (GPU on the Mac's Dashboard):** enable the Akorith **Controller API** on the PC
  (Settings → API → enable, Allow LAN), copy the URL + token.
- Do **not** port-forward Ollama to the public Internet — use Tailscale/VPN/LAN only.

## Mac (Akorith)

### Same Wi-Fi
1. Settings → Providers → Remote Ollama → **Add endpoint** → `http://<pc-lan-ip>:11434`.
2. **Test connection** → **Auto-connect**. The model picker should list the PC's models.

### Different network (Tailscale)
1. Install Tailscale, sign into the same account.
2. Settings → Providers → Remote Ollama → **Find PC over Tailscale → Check Tailscale**.
3. **Add as endpoint** for your PC (or just **Auto-connect**).
4. Model picker shows "PC via Tailscale (…)"; Dashboard runtime card reads **Ready**.

### With the Controller (GPU too)
1. Settings → API → add the PC's controller URL + token.
2. Dashboard shows the PC's GPU and an Ollama candidate derived from the controller host.

## Currency check (is the Mac app up to date?)

Settings → Update shows the installed build (`version · commit · packaged/dev`). For a source
checkout it also reports how many commits you are behind `origin/main`. Rebuild/refresh the
packaged app with `npm run dist:mac && npm run refresh:mac` to update it.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "LAN address only works on the same Wi-Fi" | You're on another network. Use Tailscale (above). |
| Tailscale shows "not installed" | Install Tailscale on both machines and sign in. |
| Tailscale "installed, off" | Open Tailscale and connect on both machines. |
| Connected, "no peer devices" | Sign the PC into the **same** tailnet/account. |
| Endpoint reachable, **0 models** | Run `ollama pull <model>` on the PC. |
| `11434` not reachable on LAN | PC firewall blocks it, or Ollama isn't bound to `0.0.0.0`. |
| Controller auth failed | Re-copy the PC controller token (Settings → API on the PC). |
| Remote **GPU unavailable** | Direct Ollama exposes no GPU — enable the Akorith Controller on the PC. |
| Worked at home, not away | PC asleep/off, or Tailscale disconnected — wake the PC, reconnect. |

## Security

- Ollama is never exposed publicly; reach the PC only over Tailscale/VPN/LAN.
- Akorith never installs Tailscale, binds Ollama to `0.0.0.0`, or opens firewall ports for you.
- Controller tokens are masked, sent only in the `Authorization` header, and never logged.
- No private IPs/hostnames are hardcoded; everything comes from your profiles or Tailscale.
