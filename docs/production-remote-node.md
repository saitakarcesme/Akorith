# Remote Akorith Node

Akorith Node lets one Akorith desktop use models running on another machine. The implemented protocol is inference-only: the node can list runtimes/models, stream generation, cancel generation, report bounded load/hardware state, and sample NVIDIA GPUs. Repository files, local commands, patches, tests, and Git stay on the desktop client.

This separation is enforced in every generation request:

```text
inferenceOnly=true
codeToolsLocation=client
nodeFilesystemAccess=false
nodeCommandExecution=false
nodeGitAccess=false
```

## Host prerequisites

On a Windows RTX host, install:

- Node.js 20 or newer (22 recommended when running from this repository);
- a current NVIDIA driver so `nvidia-smi` works;
- at least one supported local inference runtime and model:
  - Ollama at `http://127.0.0.1:11434`;
  - LM Studio OpenAI-compatible server at `http://127.0.0.1:1234`;
  - vLLM/OpenAI-compatible server at `http://127.0.0.1:8000`.

The daemon probes these loopback endpoints. The runtime should remain bound to loopback; only Akorith Node needs a network listener.

Example Ollama preparation:

```powershell
ollama serve
ollama pull qwen2.5-coder:32b
nvidia-smi
```

Use a model that fits the GPU's available VRAM and the desired context. A model appearing in a runtime catalog proves availability for generation, not coding-agent capability. Akorith's client-side code-execution probe still controls Loop eligibility.

## Build and start the daemon

From an Akorith source checkout on the Windows host:

```powershell
npm ci
npm run node:build
node .\dist-node\akorith-node.cjs --host 0.0.0.0 --port 47841 --allow-lan --name "RTX 3090 PC"
```

For development without the bundle:

```powershell
npm run node:start -- --host 0.0.0.0 --port 47841 --allow-lan --name "RTX 3090 PC"
```

`--allow-lan` is mandatory with wildcard `--host 0.0.0.0` or `::`. Without host/port arguments the daemon listens only on `127.0.0.1:47841`. Valid ports are 1024-65535.

Optional persistent-state override:

```powershell
node .\dist-node\akorith-node.cjs --host 0.0.0.0 --port 47841 --allow-lan --name "RTX 3090 PC" --state "D:\AkorithNode\state.json"
```

The default state is `%USERPROFILE%\.akorith-node\state.json`. It contains the stable node ID and SHA-256 device-token digests, never client bearer-token plaintext. It is created with restrictive file mode where the platform honors POSIX modes and is written by temporary-file rename.

Startup prints the listen address, pairing ID, six-digit one-time code, expiration, and state path. Pairing challenges normally expire after two minutes, are single-use, lock after five wrong attempts, and are not persisted across restart. Restart the daemon for a new pairing challenge.

## Windows Firewall

If Windows blocks the client, allow only TCP 47841 on the Private profile from an elevated PowerShell:

```powershell
New-NetFirewallRule -DisplayName "Akorith Node 47841 (Private)" `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 47841 -Profile Private
```

Verify listening state:

```powershell
Get-NetTCPConnection -LocalPort 47841 -State Listen
ipconfig
```

Remove the rule when the node is no longer used:

```powershell
Remove-NetFirewallRule -DisplayName "Akorith Node 47841 (Private)"
```

Do not add a router port-forward. The standalone server currently speaks HTTP; its bearer token must not cross the public internet in plaintext.

## Pair a macOS client

1. Keep the daemon terminal open and copy the current pairing ID and code.
2. On the Mac, confirm reachability to the Windows private address:

   ```bash
   curl http://192.168.1.50:47841/v1/info
   ```

   Replace `192.168.1.50` with the Windows PC's actual private address. `/v1/info` is unauthenticated and reports protocol/node identity and the inference-only policy; model/health/generation endpoints remain authenticated.
3. In Akorith, open **Settings -> Remote nodes**.
4. Enter `http://192.168.1.50:47841`, the pairing ID, the six-digit code, and a client name such as `M1 Air`.
5. Enable the explicit private-LAN HTTP acknowledgement. The client rejects plaintext HTTP even on a private address until this acknowledgement is set.
6. Select **Pair node**, then **Test**. A successful test displays the stable node identity, connection phase/latency, hardware observation, runtimes, and discovered models.
7. The remote provider now lists wire model names from that authenticated node. Run the code-execution probe before selecting one for Loop; Benchmark can select an available remote catalog model and records the node/hardware identity.

The Mac stores only a non-secret profile in `remote-nodes.json`. The bearer token is separately encrypted with Electron `safeStorage`; if OS encryption is unavailable, pairing storage fails instead of writing plaintext. Revoking the node in Settings deletes the local encrypted token/profile. Node-side device revocation is supported by the authority contract; stop or replace the node state if all existing clients must be invalidated immediately.

## Exact RTX 3090 Windows PC -> M1 Air guide

The following is the shortest reproducible same-LAN path.

### On the RTX 3090 PC

```powershell
# 1. Prove the NVIDIA driver and Ollama model are available.
nvidia-smi
ollama list

# 2. In the Akorith checkout, build the standalone Node 20 bundle.
npm ci
npm run node:build

# 3. Permit the private Windows network and start the authenticated node.
New-NetFirewallRule -DisplayName "Akorith Node 47841 (Private)" `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 47841 -Profile Private
node .\dist-node\akorith-node.cjs --host 0.0.0.0 --port 47841 --allow-lan --name "RTX 3090 PC"
```

Leave the last command running. Note its pairing ID/code, then obtain the PC's Wi-Fi/Ethernet IPv4 address with `ipconfig`.

### On the M1 Air

```bash
# Replace the address with the PC's private IPv4 address.
curl http://192.168.1.50:47841/v1/info
```

Pair in **Settings -> Remote nodes** using `http://192.168.1.50:47841`, acknowledge private-LAN HTTP, and run Test. In Loop, refresh the model catalog, choose the remote model, and run its code-execution probe. The prompt and model inference cross the private connection; the repository clone, patch validation, tests, commit, and push execute on the M1 client.

The M1 Air does not need to fit or run the 3090-hosted model. It does need the repository toolchain required by that project's validation commands, because validation is intentionally client-side.

## Tailscale recommendation

Tailscale is the recommended path when the Mac and PC are not on the same trusted LAN.

1. Install Tailscale on both machines and sign them into the same tailnet.
2. On Windows, find its tailnet IPv4 address:

   ```powershell
   tailscale ip -4
   ```

3. Start Akorith Node with the same wildcard LAN command. Do not port-forward 47841 on the router.
4. From the Mac, test the `100.x.y.z` address:

   ```bash
   curl http://100.x.y.z:47841/v1/info
   ```

5. Pair Akorith with `http://100.x.y.z:47841` and explicitly acknowledge the private HTTP transport.

Akorith classifies Tailscale's `100.64.0.0/10` carrier-grade private range as private. RFC1918, loopback, link-local, `.local`, and private IPv6 addresses are also private. Unknown DNS names are treated as public-risk. Public addresses require both explicit opt-in and HTTPS; public HTTP is rejected.

Tailscale encrypts the network tunnel, but Akorith still requires its own one-time pairing and bearer authentication. Use tailnet ACLs to limit TCP 47841 to the intended Mac device or user. Treat the node state file and client profile as sensitive operational data even though only token digests/ciphertext are persisted.

## Protocol and limits

The versioned protocol is `akorith.remote-node.v1`. It exposes:

- `GET /v1/info`: public node identity/pairing-required/safety metadata;
- `POST /v1/pair`: one-time pairing ID/code and client name;
- `POST /v1/request`: authenticated health, catalog, generate, and cancel envelopes;
- NDJSON generation events: started, deltas, usage, completed, cancelled, or bounded error.

The server caps JSON requests, validates protocol/request IDs and the exact safety policy, authenticates device tokens with constant-time digest comparison, bounds generation concurrency/queue/output, and maps only catalog model keys to registered runtime adapters. Cancellation propagates to the runtime fetch.

Client monitoring polls a healthy node every 30 seconds. Failures use jittered exponential backoff from roughly two seconds to two minutes and expose connecting/online/degraded/offline state. Credentials are redacted from stored/displayed errors.

GPU observation is through fixed `nvidia-smi` executable/arguments with `shell: false`, a three-second command timeout, and 128 KiB output cap. If the executable, driver, or metric is absent, the node reports unavailable with a reason; it never emits a made-up GPU value.
