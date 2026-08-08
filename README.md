# unifi-mcp-server

An MCP (Model Context Protocol) server that lets Claude manage your Ubiquiti
UniFi network through the **official UniFi Network API** — list devices and
clients, check health stats, inspect networks/WiFi/firewall config, restart
devices, power-cycle PoE ports, manage guest access and hotspot vouchers.

## How it works

```
┌────────────┐   JSON-RPC over stdio   ┌──────────────────┐   HTTPS + X-API-KEY   ┌───────────────┐
│ Claude Code │ ◄────────────────────► │ unifi-mcp-server │ ◄──────────────────►  │ UniFi console │
│  (client)   │    tools/list,         │  (this project,  │  /proxy/network/      │ (UDM, UCG,    │
│             │    tools/call          │   Node process)  │  integration/v1/...   │  Cloud Key…)  │
└────────────┘                         └──────────────────┘                       └───────────────┘
```

- **Where it runs**: on your machine. Claude Code launches `node dist/index.js`
  as a subprocess each session and talks JSON-RPC to it over stdin/stdout.
  Nothing is hosted anywhere; the only network traffic is HTTPS from this
  machine to your console.
- **What a "tool" is**: a typed function this server registers (e.g.
  `unifi_list_devices`). Claude sees each tool's name, description, and input
  schema, decides when to call it, and gets text back.
- **Auth**: a UniFi API key sent as the `X-API-KEY` header. The key lives in an
  environment variable — never in code.

## Requirements

- A UniFi OS console (UDM/UDR/UCG/Cloud Key Gen2+, port 443) or UniFi OS Server
  (port 11443) running **Network 9.0+**. Network **10.x** unlocks the full tool
  set (networks, WiFi, firewall, ACL, DNS tools); on 9.x those return a clear
  "not supported" error while devices/clients/vouchers still work.
  ⚠ The legacy self-hosted Network Server (port 8443) does not support API-key
  auth and will not work with this server.
- Node.js 18+ on this machine.

## Setup

### 1. Create a UniFi API key

1. Open your UniFi console in a browser and go to the **Network** application.
2. Go to **Settings → Control Plane → Integrations** (on newer 10.x versions
   this may appear as **Settings → Integrations**).
3. Click **Create API Key**, name it (e.g. `claude-mcp`), and **copy it
   immediately — it is shown only once.**

### 2. Build

```bash
npm install
npm run build
```

### 3. Register with Claude Code

```bash
claude mcp add --scope user unifi --env UNIFI_BASE_URL=https://YOUR_CONSOLE_IP --env UNIFI_API_KEY=YOUR_KEY --env UNIFI_TLS_VERIFY=false -- node "C:\Users\Nic\Documents\Claude\Code\MCP-UniFi\dist\index.js"
```

- `--scope user` makes the server available in every project (omit for
  just the current one).
- Drop `--env UNIFI_TLS_VERIFY=false` if your console has a real (trusted)
  TLS certificate — verification is on by default. The flag is needed for the
  self-signed certificate consoles ship with; the server logs a warning when
  verification is off.
- The key is stored in your user-level Claude settings file in your profile
  directory. If you prefer it in a system environment variable instead, set
  `UNIFI_API_KEY` machine-wide and register without the `--env UNIFI_API_KEY`
  flag — the server reads the process environment.

Verify with `claude mcp list`, then just ask Claude things like:

- "Which UniFi devices are offline right now?"
- "Show me the health stats for my main switch."
- "What clients are on the guest network?"
- "Generate 5 guest WiFi vouchers for the weekend, 24h each."
- "Power-cycle the PoE port my camera is on." *(asks you to confirm first)*

### Configuration reference

| Env var | Required | Default | Meaning |
|---|---|---|---|
| `UNIFI_BASE_URL` | yes | — | Console origin, e.g. `https://192.168.1.1` |
| `UNIFI_API_KEY` | yes | — | API key from Settings → Control Plane → Integrations |
| `UNIFI_TLS_VERIFY` | no | `true` | TLS cert validation (secure by default). Set `false` only for self-signed console certs on a trusted LAN — it allows on-path interception of the API key. |
| `UNIFI_API_PATH` | no | `/proxy/network/integration` | Path prefix override (rarely needed) |

## Tools (28)

**Read-only (21)** — safe, no side effects:
`unifi_get_application_info`, `unifi_list_sites`, `unifi_list_devices`,
`unifi_get_device`, `unifi_get_device_statistics`, `unifi_list_pending_devices`,
`unifi_list_clients`, `unifi_get_client`, `unifi_list_networks`,
`unifi_get_network`, `unifi_list_wans`, `unifi_list_vpn`, `unifi_list_wifi`,
`unifi_get_wifi`, `unifi_list_firewall_policies`, `unifi_get_firewall_policy`,
`unifi_list_firewall_zones`, `unifi_list_acl_rules`, `unifi_list_dns_policies`,
`unifi_list_vouchers`

**Actions (7)** — change things; Claude Code prompts for permission, and the
risky ones are annotated `destructiveHint` so clients can warn:
`unifi_adopt_device`, `unifi_restart_device` ⚠, `unifi_power_cycle_port` ⚠,
`unifi_authorize_guest_access`, `unifi_unauthorize_guest_access` ⚠,
`unifi_generate_vouchers`, `unifi_delete_voucher` ⚠,
`unifi_set_firewall_policy_enabled` ⚠

List tools support `limit`/`offset` pagination and UniFi filter expressions,
e.g. `state.eq('OFFLINE')`, `access.type.eq('GUEST')`, `name.like('Office*')`.

## Security notes

- The API key is only read from the environment and never appears in tool
  output or logs.
- WiFi passphrases and any credential-looking fields are redacted from
  responses.
- TLS verification is ON by default. `UNIFI_TLS_VERIFY=false` is an explicit
  opt-out for self-signed console certs (the server logs a warning); install a
  proper certificate on the console to remove the need for it.
- All resource IDs are validated as UUIDs before being placed in URLs, so a
  malformed ID can never redirect a request to a different endpoint.
- Write tools describe their blast radius in their descriptions so Claude
  confirms with you before rebooting infrastructure.

## Known limitations (of the official UniFi API, not this server)

Not available in the official Integration API as of v10.4.57 — these would
require the unofficial legacy API (a possible phase 2):

- Block / unblock / kick a client
- Firmware upgrades, locate-LED
- Port forwarding, static routes, traffic rules/QoS, per-port switch config
- Historical statistics, events, alarms (only latest per-device stats exist)

## Development

```bash
npm run dev        # run from source (tsx)
npm run build      # compile to dist/
npm run inspect    # open MCP Inspector against the built server
```

Ground truth for the API: `https://developer.ui.com/network/v10.4.57/openapi.json`
(also `llms.txt` and a Postman collection at the same base URL).
