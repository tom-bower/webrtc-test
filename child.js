// clusterNode.js
import express from 'express';
import WebSocket from 'ws';
import si from 'systeminformation';
import client from 'prom-client';
import { launchClients, getClientMetrics } from './rampClientManager.js';

const app = express();
const port = process.env.METRICS_PORT || 9100;

// Prometheus registry
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const cpuGauge = new client.Gauge({ name: 'ramp_node_cpu_usage_percent', help: 'CPU usage %' });
const memGauge = new client.Gauge({ name: 'ramp_node_memory_usage_percent', help: 'Memory usage %' });
const clientsGauge = new client.Gauge({ name: 'ramp_node_clients_connected', help: 'Connected clients' });
const dropsCounter = new client.Counter({ name: 'ramp_node_clients_dropped_total', help: 'Dropped clients' });
const bitrateGauge = new client.Gauge({ name: 'ramp_node_avg_bitrate_bps', help: 'Avg bitrate per node' });
const rttGauge = new client.Gauge({ name: 'ramp_node_avg_rtt_ms', help: 'Avg RTT per node' });
const jitterGauge = new client.Gauge({ name: 'ramp_node_avg_jitter_ms', help: 'Avg jitter per node' });

register.registerMetric(cpuGauge);
register.registerMetric(memGauge);
register.registerMetric(clientsGauge);
register.registerMetric(dropsCounter);
register.registerMetric(bitrateGauge);
register.registerMetric(rttGauge);
register.registerMetric(jitterGauge);

// Connect to coordinator
const coordinatorUrl = process.env.COORDINATOR_WS || 'ws://coordinator:8080';
const ws = new WebSocket(coordinatorUrl);

ws.on('message', async (msg) => {
  const data = JSON.parse(msg);
  if (data.type === 'LAUNCH_CLIENTS') {
    await launchClients(data.count, data.streamUrl);
  }
});

// Update metrics loop
setInterval(async () => {
  const cpu = await si.currentLoad();
  const mem = await si.mem();
  const { clients, drops, avgBitrate, avgRtt, avgJitter } = getClientMetrics();

  cpuGauge.set(cpu.currentLoad);
  memGauge.set((mem.active / mem.total) * 100);
  clientsGauge.set(clients);
  bitrateGauge.set(avgBitrate);
  rttGauge.set(avgRtt);
  jitterGauge.set(avgJitter);

  if (drops > 0) dropsCounter.inc(drops);
}, 5000);

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.listen(port, () => console.log(`Metrics exporter running on port ${port}`));
