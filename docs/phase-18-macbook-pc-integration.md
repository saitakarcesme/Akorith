# Phase 18: MacBook + PC Ollama Integration

Akorith can point its Local (Ollama) provider at any reachable Ollama HTTP endpoint. This lets a MacBook run Akorith while using models hosted on a stronger Windows PC.

## Recommended shape

- PC: runs Ollama and hosts the models.
- MacBook: runs Akorith and sets Settings -> Ollama endpoint to the PC endpoint.
- Different networks: use a private VPN/tunnel endpoint such as Tailscale, WireGuard, or a protected Cloudflare Tunnel. Do not expose raw `11434` directly to the public internet.

## PC host

For LAN access, start Ollama bound to all interfaces:

```powershell
$env:OLLAMA_HOST = "0.0.0.0:11434"
ollama serve
```

If Akorith starts Ollama on the PC, keep **Expose local Ollama on LAN** enabled in Settings. Akorith sets `OLLAMA_HOST=0.0.0.0:11434` for its auto-started server.

Phase 18.1 adds a friendlier path: open Settings on the PC and use **This machine** under **Ollama endpoint**. Akorith lists ready-made local, LAN, and VPN/Tailscale-style endpoints. Copy the LAN or VPN endpoint and use it on the MacBook.

For different networks, keep Ollama bound privately and publish it through your VPN/tunnel tool. The MacBook needs an endpoint like:

```text
http://100.x.y.z:11434
https://your-protected-tunnel.example.com
```

## MacBook client

1. Open Akorith.
2. Open Settings from the profile button.
3. Paste the PC endpoint from the PC's **This machine** list into **Ollama endpoint**.
4. Click **Test**. Akorith calls `/api/tags` and reports the model count.
5. Click **Save**. The Local (Ollama) provider now uses the PC-hosted models.

## Notes

- Chat, Test Lab generation, router classification, and any Local provider call use the configured endpoint.
- If the endpoint is not loopback, Akorith will not try to auto-start Ollama on the MacBook.
- The Electron main process performs the HTTP call, so browser CORS does not block remote Ollama usage.
