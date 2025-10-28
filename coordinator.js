import WebSocket, { WebSocketServer } from "ws";
import express from "express";
import client from "prom-client";

const PORT = 9000;
const FIB_SEQUENCE = [1,2,3,5,8,13,21,34,55,89,144,233,377,500];
const RAMP_INTERVAL_MS = 2 * 60 * 1000; // 2 min per step

let nodes = [];
let lastTotalClients = 0;

// ---------------- Prometheus ----------------
const register = new client.Registry();
client.collectDefaultMetrics({ register });

// Cluster-level
const totalClientsGauge = new client.Gauge({
  name: "ome_cluster_connected_clients_total",
  help: "Total connected clients across all nodes"
});
const dropRateGauge = new client.Gauge({
  name: "ome_cluster_drop_rate",
  help: "Fraction of clients lost since previous sample"
});
const avgStartupGauge = new client.Gauge({
  name: "ome_cluster_avg_startup_delay_ms",
  help: "Average startup delay (ms)"
});
const avgBitrateGauge = new client.Gauge({
  name: "ome_cluster_avg_bitrate_bps",
  help: "Average bitrate (bps)"
});
const avgBuffersGauge = new client.Gauge({
  name: "ome_cluster_avg_buffer_events",
  help: "Average buffer count per client"
});
const avgBufferTimeGauge = new client.Gauge({
  name: "ome_cluster_avg_buffer_time_ms",
  help: "Average buffering time per client (ms)"
});

register.registerMetric(totalClientsGauge);
register.registerMetric(dropRateGauge);
register.registerMetric(avgStartupGauge);
register.registerMetric(avgBitrateGauge);
register.registerMetric(avgBuffersGauge);
register.registerMetric(avgBufferTimeGauge);

// Node-level gauges (dynamic labels)
const nodeCpuGauge = new client.Gauge({
  name: "ome_cluster_node_cpu_load",
  help: "Node CPU load average (1m)",
  labelNames: ["node"]
});
const nodeMemGauge = new client.Gauge({
  name: "ome_cluster_node_memory_used_ratio",
  help: "Node memory utilization ratio",
  labelNames: ["node"]
});
const nodeClientsGauge = new client.Gauge({
  name: "ome_cluster_node_clients",
  help: "Number of clients on node",
  labelNames: ["node"]
});
const nodeFailuresGauge = new client.Gauge({
  name: "ome_cluster_node_browser_failures_total",
  help: "Browser/client restarts observed",
  labelNames: ["node"]
});

register.registerMetric(nodeCpuGauge);
register.registerMetric(nodeMemGauge);
register.registerMetric(nodeClientsGauge);
register.registerMetric(nodeFailuresGauge);

// ---------------- HTTP Metrics endpoint ----------------
const app = express();
app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});
app.listen(9464, () =>
  console.log(`📊 Prometheus metrics: http://localhost:9464/metrics`)
);

// ---------------- WebSocket ----------------
const wss = new WebSocketServer({ port: PORT });
console.log(`🟢 Coordinator listening on ws://localhost:${PORT}`);

wss.on("connection", (ws) => {
  const nodeId = `node-${nodes.length + 1}`;
  const node = { id: nodeId, ws, lastReport: Date.now(), metrics: {} };
  nodes.push(node);
  ws.send(JSON.stringify({ type: "register", nodeId }));
  console.log(`Node joined: ${nodeId}`);

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === "report") {
        node.lastReport = Date.now();
        node.metrics = data.metrics;
        updatePromMetrics();
      }
    } catch (e) {
      console.warn(`Bad message from ${nodeId}:`, e);
    }
  });

  ws.on("close", () => {
    console.log(`❌ Node disconnected: ${nodeId}`);
    nodes = nodes.filter((n) => n !== node);
  });
});

// ---------------- Metrics aggregation ----------------
function updatePromMetrics() {
  const active = nodes.filter(
    (n) => Date.now() - n.lastReport < 30000 && n.metrics.connected !== undefined
  );
  if (!active.length) return;

  let totalClients = 0;
  let sumStartup = 0, sumBitrate = 0, sumBuffers = 0, sumBufTime = 0;
  active.forEach((n) => {
    const m = n.metrics;
    totalClients += m.connected || 0;
    sumStartup += m.avgStartup || 0;
    sumBitrate += m.avgBitrate || 0;
    sumBuffers += m.avgBuffers || 0;
    sumBufTime += m.avgBufferTime || 0;

    nodeCpuGauge.labels(n.id).set(m.cpu || 0);
    nodeMemGauge.labels(n.id).set(m.mem || 0);
    nodeClientsGauge.labels(n.id).set(m.clients || 0);
    nodeFailuresGauge.labels(n.id).set(m.failures || 0);
  });

  const avgStartup = sumStartup / active.length;
  const avgBitrate = sumBitrate / active.length;
  const avgBuffers = sumBuffers / active.length;
  const avgBufTime = sumBufTime / active.length;

  const dropRate =
    lastTotalClients > 0
      ? Math.max(0, (lastTotalClients - totalClients) / lastTotalClients)
      : 0;

  totalClientsGauge.set(totalClients);
  avgStartupGauge.set(avgStartup);
  avgBitrateGauge.set(avgBitrate);
  avgBuffersGauge.set(avgBuffers);
  avgBufferTimeGauge.set(avgBufTime);
  dropRateGauge.set(dropRate);

  lastTotalClients = totalClients;
}

// ---------------- Ramp sequence ----------------
async function ramp() {
  for (const [i, total] of FIB_SEQUENCE.entries()) {
    if (nodes.length === 0) {
      console.warn("Waiting for nodes...");
      await sleep(5000);
      continue;
    }
    console.log(`\n🚀 Ramp step ${i + 1}/${FIB_SEQUENCE.length}: ${total} total`);
    const perNode = Math.floor(total / nodes.length);
    let rem = total % nodes.length;
    nodes.forEach((n, idx) => {
      const target = perNode + (idx < rem ? 1 : 0);
      n.ws.send(JSON.stringify({ type: "ramp", clients: target, step: i }));
      console.log(`→ ${n.id}: ${target}`);
    });
    await sleep(RAMP_INTERVAL_MS);
  }
  console.log("🎯 Ramp finished.");
}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
setTimeout(ramp, 5000);
