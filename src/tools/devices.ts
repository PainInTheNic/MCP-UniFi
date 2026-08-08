/**
 * Device tools: the UniFi hardware itself (gateways, switches, access points).
 * Read tools cover inventory, details, and live statistics; action tools can
 * restart a device or power-cycle a PoE switch port.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UniFiClient } from "../unifi-client.js";
import {
  ResponseFormat,
  formatUptime,
  jsonBlock,
  line,
  lines,
  textResult,
} from "../format.js";
import {
  filterField,
  guard,
  limitField,
  offsetField,
  responseFormatField,
  runListTool,
  siteIdField,
  uuidField,
} from "./shared.js";

interface DeviceSummary {
  id: string;
  name?: string;
  model?: string;
  macAddress?: string;
  ipAddress?: string;
  state?: string;
  features?: string[];
}

interface DeviceDetails extends DeviceSummary {
  firmwareVersion?: string;
  firmwareUpdatable?: boolean;
  adoptedAt?: string;
  uplink?: { deviceId?: string };
  interfaces?: {
    ports?: Array<{ idx?: number; state?: string; connector?: string; maxSpeedMbps?: number; speedMbps?: number; poe?: { enabled?: boolean; state?: string } }>;
    radios?: Array<{ wlanStandard?: string; frequencyGHz?: number; channel?: number; channelWidthMHz?: number }>;
  };
}

interface DeviceStatistics {
  uptimeSec?: number;
  lastHeartbeatAt?: string;
  cpuUtilizationPct?: number;
  memoryUtilizationPct?: number;
  loadAverage1Min?: number;
  uplink?: { txRateBps?: number; rxRateBps?: number };
  [key: string]: unknown;
}

/** Pending devices are not yet adopted, so they have no id — MAC is the key. */
interface PendingDevice {
  macAddress?: string;
  model?: string;
  ipAddress?: string;
  state?: string;
  firmwareVersion?: string;
  supported?: boolean;
}

function deviceBullet(d: DeviceSummary): string {
  const state = d.state ? ` — ${d.state}` : "";
  return lines(
    `- **${d.name ?? d.model ?? "unnamed"}**${state}`,
    line("  id", `\`${d.id}\``),
    line("  model", d.model),
    line("  MAC", d.macAddress),
    line("  IP", d.ipAddress),
  );
}

export function registerDeviceTools(server: McpServer, client: UniFiClient): void {
  server.registerTool(
    "unifi_list_devices",
    {
      title: "List UniFi Devices",
      description:
        "List UniFi devices (gateways, switches, access points) adopted on a site, with name, model, MAC, IP, and state (ONLINE, OFFLINE, UPDATING, CONNECTION_INTERRUPTED, ISOLATED, ...). Use unifi_get_device for full details of one device. Filter example: \"state.eq('OFFLINE')\" to find offline devices.",
      inputSchema: {
        siteId: siteIdField,
        filter: filterField,
        limit: limitField,
        offset: offsetField,
        responseFormat: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, filter, limit, offset, responseFormat }) =>
      runListTool<DeviceSummary>({
        client,
        siteId,
        limit,
        offset,
        format: responseFormat,
        params: filter ? { filter } : undefined,
        path: (site) => `/v1/sites/${site}/devices`,
        heading: "UniFi devices",
        emptyMessage: "No adopted devices found on this site.",
        formatItem: deviceBullet,
      }),
  );

  server.registerTool(
    "unifi_get_device",
    {
      title: "Get UniFi Device Details",
      description:
        "Get full details for one adopted UniFi device by ID: firmware version and update availability, adoption time, port table (with PoE state), and radio table. Get device IDs from unifi_list_devices.",
      inputSchema: {
        siteId: siteIdField,
        deviceId: uuidField("Device ID (UUID from unifi_list_devices)"),
        responseFormat: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, deviceId, responseFormat }) =>
      guard(async () => {
        const site = await client.resolveSiteId(siteId);
        const d = await client.get<DeviceDetails>(`/v1/sites/${site}/devices/${deviceId}`);
        if (responseFormat === ResponseFormat.JSON) return textResult(jsonBlock(d));

        const ports = (d.interfaces?.ports ?? [])
          .map((p) =>
            `  - Port ${p.idx}: ${p.state ?? "?"}${p.speedMbps ? ` @ ${p.speedMbps} Mbps` : ""}${p.poe?.enabled ? ` (PoE: ${p.poe.state ?? "enabled"})` : ""}`,
          )
          .join("\n");
        const radios = (d.interfaces?.radios ?? [])
          .map((r) => `  - ${r.frequencyGHz ?? "?"} GHz${r.channel ? `, channel ${r.channel}` : ""}${r.channelWidthMHz ? ` @ ${r.channelWidthMHz} MHz` : ""}${r.wlanStandard ? ` (${r.wlanStandard})` : ""}`)
          .join("\n");

        return textResult(
          lines(
            `## ${d.name ?? d.model ?? "Device"} (${d.state ?? "state unknown"})`,
            line("ID", `\`${d.id}\``),
            line("Model", d.model),
            line("MAC", d.macAddress),
            line("IP", d.ipAddress),
            line("Firmware", d.firmwareVersion),
            line("Firmware update available", d.firmwareUpdatable === true ? "yes" : d.firmwareUpdatable === false ? "no" : undefined),
            line("Adopted at", d.adoptedAt),
            ports ? `- **Ports**:\n${ports}` : undefined,
            radios ? `- **Radios**:\n${radios}` : undefined,
          ),
        );
      }),
  );

  server.registerTool(
    "unifi_get_device_statistics",
    {
      title: "Get UniFi Device Statistics",
      description:
        "Get the latest live statistics for one adopted device: uptime, CPU %, memory %, load average, and uplink throughput (bits/sec). Good for health checks and 'is this AP overloaded?' questions.",
      inputSchema: {
        siteId: siteIdField,
        deviceId: uuidField("Device ID (UUID from unifi_list_devices)"),
        responseFormat: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, deviceId, responseFormat }) =>
      guard(async () => {
        const site = await client.resolveSiteId(siteId);
        const s = await client.get<DeviceStatistics>(`/v1/sites/${site}/devices/${deviceId}/statistics/latest`);
        if (responseFormat === ResponseFormat.JSON) return textResult(jsonBlock(s));
        const mbps = (bps?: number) => (bps === undefined ? undefined : `${(bps / 1_000_000).toFixed(1)} Mbps`);
        return textResult(
          lines(
            "## Device statistics (latest)",
            line("Uptime", formatUptime(s.uptimeSec)),
            line("CPU", s.cpuUtilizationPct !== undefined ? `${s.cpuUtilizationPct.toFixed(1)}%` : undefined),
            line("Memory", s.memoryUtilizationPct !== undefined ? `${s.memoryUtilizationPct.toFixed(1)}%` : undefined),
            line("Load (1 min)", s.loadAverage1Min),
            line("Uplink TX", mbps(s.uplink?.txRateBps)),
            line("Uplink RX", mbps(s.uplink?.rxRateBps)),
            line("Last heartbeat", s.lastHeartbeatAt),
          ),
        );
      }),
  );

  server.registerTool(
    "unifi_list_pending_devices",
    {
      title: "List Devices Pending Adoption",
      description:
        "List UniFi devices that are visible on the network but not yet adopted into the controller. Console-wide (not site-scoped).",
      inputSchema: {
        limit: limitField,
        offset: offsetField,
        responseFormat: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ limit, offset, responseFormat }) =>
      guard(async () => {
        const page = await client.page<PendingDevice>("/v1/pending-devices", { limit, offset });
        if (page.data.length === 0) return textResult("No devices are pending adoption.");
        if (responseFormat === ResponseFormat.JSON) return textResult(jsonBlock(page));
        const body = page.data
          .map((d) =>
            lines(
              `- **${d.model ?? "device"}**${d.state ? ` — ${d.state}` : ""}`,
              line("  MAC", d.macAddress),
              line("  IP", d.ipAddress),
              line("  firmware", d.firmwareVersion),
              d.supported === false ? "  - **NOT supported by this console**" : undefined,
            ),
          )
          .join("\n");
        return textResult(
          `## Devices pending adoption\n\n${body}\n\nUse unifi_adopt_device with a MAC address to adopt one.`,
        );
      }),
  );

  server.registerTool(
    "unifi_adopt_device",
    {
      title: "Adopt Pending Device",
      description:
        "Adopt a pending UniFi device (from unifi_list_pending_devices) into a site, identified by its MAC address. The device will provision and join the network under this controller.",
      inputSchema: {
        siteId: siteIdField,
        macAddress: z
          .string()
          .regex(/^[0-9a-fA-F]{2}([:-][0-9a-fA-F]{2}){5}$/, "MAC address like aa:bb:cc:dd:ee:ff")
          .describe("MAC address of the pending device (from unifi_list_pending_devices)"),
        ignoreDeviceLimit: z
          .boolean()
          .default(false)
          .describe("Adopt even if it would exceed the console's device limit (default false)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, macAddress, ignoreDeviceLimit }) =>
      guard(async () => {
        const site = await client.resolveSiteId(siteId);
        // ignoreDeviceLimit is a required field in the adoption request schema
        await client.post(`/v1/sites/${site}/devices`, { macAddress, ignoreDeviceLimit });
        return textResult(`Adoption started for device ${macAddress}. It will take a few minutes to provision; check unifi_list_devices for its state.`);
      }),
  );

  server.registerTool(
    "unifi_unadopt_device",
    {
      title: "Remove (Unadopt) Device",
      description:
        "Remove (un-adopt) an adopted UniFi device from this site, returning it to the pending-adoption pool. The device keeps running with its current configuration but leaves this controller's management until re-adopted — it is NOT factory-reset. It reappears in unifi_list_pending_devices and can be re-added with unifi_adopt_device. CAUTION: this drops the device from management; confirm with the user before removing infrastructure.",
      inputSchema: {
        siteId: siteIdField,
        deviceId: uuidField("Device ID (UUID from unifi_list_devices)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, deviceId }) =>
      guard(async () => {
        const site = await client.resolveSiteId(siteId);
        await client.delete(`/v1/sites/${site}/devices/${deviceId}`);
        return textResult(
          `Device ${deviceId} removed from management. It will reappear in unifi_list_pending_devices and can be re-adopted with unifi_adopt_device.`,
        );
      }),
  );

  server.registerTool(
    "unifi_restart_device",
    {
      title: "Restart UniFi Device",
      description:
        "Restart (reboot) one adopted UniFi device. CAUTION: the device drops all traffic while rebooting — restarting a gateway or the switch/AP serving this machine will cause an outage of a minute or more. Confirm with the user before restarting shared infrastructure.",
      inputSchema: {
        siteId: siteIdField,
        deviceId: uuidField("Device ID (UUID from unifi_list_devices)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ siteId, deviceId }) =>
      guard(async () => {
        const site = await client.resolveSiteId(siteId);
        await client.post(`/v1/sites/${site}/devices/${deviceId}/actions`, { action: "RESTART" });
        return textResult(`Restart command sent to device ${deviceId}. It will be offline for roughly 1-3 minutes while it reboots.`);
      }),
  );

  server.registerTool(
    "unifi_power_cycle_port",
    {
      title: "Power-Cycle a PoE Port",
      description:
        "Power-cycle a single PoE port on a UniFi switch — briefly cuts and restores power to whatever is plugged into that port (camera, AP, phone). Useful to remotely reboot a hung PoE device. CAUTION: the connected device loses power; confirm with the user first.",
      inputSchema: {
        siteId: siteIdField,
        deviceId: uuidField("Switch device ID (UUID from unifi_list_devices)"),
        portIdx: z.number().int().min(1).describe("Port number as shown in unifi_get_device's port table"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ siteId, deviceId, portIdx }) =>
      guard(async () => {
        const site = await client.resolveSiteId(siteId);
        await client.post(`/v1/sites/${site}/devices/${deviceId}/interfaces/ports/${portIdx}/actions`, {
          action: "POWER_CYCLE",
        });
        return textResult(`Power-cycle command sent to port ${portIdx} on device ${deviceId}.`);
      }),
  );
}
