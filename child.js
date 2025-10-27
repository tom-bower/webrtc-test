import puppeteer from "puppeteer";
import WebSocket from "ws";
import express from "express";
import client from "prom-client";
import fs from "fs";
import { createObjectCsvWriter } from "csv-writer";

// ==============================
// CONFIGURATION
// ==============================
const COORDINATOR_URL = "ws://localhost:9000"; // replace with coordinator
const STREAM_URL = "ws://localhost:3333/app/stream"; // your OME WebRTC stream
const METRICS_INTERVAL_MS = 10000;

// ==============================
// STATE
// ==============================
const clients = [];
const metrics = [];
let currentLoadStep = 0;

// ==============================
// CSV WRITER
// ==============================
const csvWriter = createObjectCsvWriter({
  path: "ome_qoe_metrics.csv",
  header: [
    { id: "id", title: "ClientID" },
    { id: "connected", title: "Connected" },
    { id: "startupDelay", title: "StartupDelay(ms)" },
    { id: "bufferEvents", title: "BufferEvents" },
    { id: "bufferTime", title: "BufferTime(ms)" },
    { id: "bitrate", title: "Bitrate(bps)" },
    { id: "frameDrops", title: "DroppedFrames" },
    { id: "playbackTime", title: "PlaybackTime(ms)" },
    { id: "error", title: "Error" },
    { id: "timestamp", title: "Timestamp" },
    { id: "loadStep", title: "LoadStep" },
  ],
});

// ==============================
// PROMETHEUS METRICS
// ==============================
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const qoeConnected = new client.Gauge({
  name: "ome_qoe_connected_clients",
  help: "Number of connected clients",
  labelNames: ["load_step"],
});
const qoeAvgStartup = new client.Gauge({
  name: "ome_qoe_avg_startup_delay_ms",
  help: "Average startup delay (ms)",
  labelNames: ["load_step"],
});
const qoeAvgBitrate = new client.Gauge({
  name: "ome_qoe_avg_bitrate_bps",
  help: "Average bitrate (bps)",
  labelNames: ["load_step"],
});
const qoeAvgBuffers = new client.Gauge({
  name: "ome_qoe_avg_buffer_events",
  help: "Average buffering events per client",
  labelNames: ["load_step"],
});
const qoeAvgBufferTime = new client.Gauge({
  name: "ome_qoe_avg_buffer_time_ms",
  help: "Average buffering time per client (ms)",
  labelNames: ["load_step"],
});

register.registerMetric(qoeConnected);
register.registerMetric(qoeAvgStartup);
register.registerMetric(qoeAvgBitrate);
register.registerMetric(qoeAvgBuffers);
register.registerMetric(qoeAvgBufferTime);

// ==============================
// PROMETHEUS EXPORT SERVER
// ==============================
const app = express();
app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});
app.listen(9464, () => console.log("📊 Prometheus metrics at http://localhost:9464/metrics"));

// ==============================
// UTILITIES
// ==============================
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function saveMetrics() {
  await csvWriter.writeRecords(metrics);
}

function updatePrometheus(summary, step) {
  const labels = { load_step: String(step) };
  qoeConnected.set(labels, summary.connected);
  qoeAvgStartup.set(labels, summary.avgStartup || 0);
  qoeAvgBitrate.set(labels, summary.avgBitrate || 0);
  qoeAvgBuffers.set(labels, summary.avgBuffers || 0);
  qoeAvgBufferTime.set(labels, summary.avgBufferTime || 0);
}

function summarize() {
  const total = metrics.length;
  const ok = metrics.filter((m) => m.connected).length;
  const avgStartup =
    metrics.filter((m) => m.startupDelay).reduce((a, b) => a + b.startupDelay, 0) / (ok || 1);
  const avgBuffers =
    metrics.reduce((a, b) => a + (b.bufferEvents || 0), 0) / (total || 1);
  const avgBufferTime =
    metrics.reduce((a, b) => a + (b.bufferTime || 0), 0) / (ok || 1);
  const avgBitrate =
    metrics.reduce((a, b) => a + (b.bitrate || 0), 0) / (ok || 1);

  const summary = { connected: ok, avgStartup, avgBuffers, avgBufferTime, avgBitrate };
  updatePrometheus(summary, currentLoadStep);

  console.log(`Load step ${currentLoadStep}: ${ok}/${total} connected, avgStartup=${avgStartup.toFixed(1)}ms, avgBitrate=${(avgBitrate/1e6).toFixed(2)}Mbps`);

  return summary;
}

// ==============================
// CLIENT HANDLER
// ==============================
async function launchClient(id) {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });

  const page = await browser.newPage();

  await page.setContent(`
    <html>
      <body>
        <div id="player-${id}"></div>
        <video id="v${id}" autoplay playsinline muted></video>
        <script src="https://cdn.jsdelivr.net/npm/ovenplayer/dist/ovenplayer.js"></script>
        <script>
          const metrics = { startTime: performance.now(), firstFrameTime: null, bufferingEvents:0, bufferingDuration:0, lastBufferStart:null, bitrate:0, frameDropCount:0, playbackTime:0, connected:false, error:null };
          const player = OvenPlayer.create("player-${id}", { sources:[{type:"webrtc", file:"${STREAM_URL}"}] });

          player.on("ready", () => { metrics.connected = true; });
          player.on("playing", () => { if(!metrics.firstFrameTime) metrics.firstFrameTime = performance.now() - metrics.startTime; });
          player.on("bufferingstart", () => { metrics.bufferingEvents++; metrics.lastBufferStart = performance.now(); });
          player.on("bufferingend", () => { if(metrics.lastBufferStart) metrics.bufferingDuration += performance.now() - metrics.lastBufferStart; });
          player.on("error", e => { metrics.error = e.message; });

          setInterval(async()=>{
            try {
              const pc = player.getRTCConnection && player.getRTCConnection();
              if(pc) {
                const stats = await pc.getStats();
                stats.forEach(r=>{
                  if(r.type==="inbound-rtp"&&r.mediaType==="video"){
                    if(metrics.lastBytes!==undefined){
                      const delta = r.bytesReceived-metrics.lastBytes;
                      const timeDelta = (r.timestamp-metrics.lastTs)/1000;
                      metrics.bitrate = (delta*8)/(timeDelta||1);
                    }
                    metrics.lastBytes = r.bytesReceived;
                    metrics.lastTs = r.timestamp;
                  }
                });
              }
            }catch(e){}
          },5000);

          window.collectMetrics=()=>{ const v=document.querySelector("#v${id}"); if(v&&v.getVideoPlaybackQuality){ metrics.frameDropCount=v.getVideoPlaybackQuality().droppedVideoFrames; } metrics.playbackTime=performance.now()-metrics.startTime; return { connected:metrics.connected, startupDelay:metrics.firstFrameTime, bufferEvents:metrics.bufferingEvents, bufferTime:metrics.bufferingDuration, bitrate:metrics.bitrate, frameDrops:metrics.frameDropCount, playbackTime:metrics.playbackTime, error:metrics.error }; };
        </script>
      </body>
    </html>
  `);

  clients.push({ id, browser, page });
  metrics.push({ id, connected:false, startupDelay:null, bufferEvents:0, bufferTime:0, bitrate:0, frameDrops:0, playbackTime:0, error:null, timestamp:new Date().toISOString(), loadStep: currentLoadStep });
}

async function pollMetrics() {
  for (const c of clients) {
    try {
      const data = await c.page.evaluate(() => window.collectMetrics());
      const i = metrics.findIndex(m => m.id===c.id);
      metrics[i] = { ...metrics[i], ...data, timestamp:new Date().toISOString(), loadStep: currentLoadStep };
    } catch(e) { console.warn(`Failed polling client ${c.id}: ${e.message}`); }
  }
  await saveMetrics();
  summarize();
}

// ==============================
// CLUSTER WS HANDLER
// ==============================
const ws = new WebSocket(COORDINATOR_URL);
ws.on("open", () => console.log("✅ Connected to coordinator"));
ws.on("message", async (msg) => {
  const data = JSON.parse(msg);
  if(data.type==="ramp"){
    currentLoadStep = data.step;
    const toAdd = data.clients - clients.length;
    console.log(`\n[Coordinator] Step ${data.step}, spawning ${toAdd} clients`);
    for(let i=0;i<toAdd;i++){
      await launchClient(clients.length+1);
      await wait(500);
    }
    await pollMetrics();
  }
});

// ==============================
// CLEANUP
// ==============================
process.on("SIGINT", async () => {
  console.log("\n🧹 Closing browsers...");
  for(const c of clients) await c.browser.close();
  await saveMetrics();
  process.exit(0);
});
