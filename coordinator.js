import WebSocket, { WebSocketServer } from "ws";

const PORT = 9000;
const FIB_SEQUENCE = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 500];
const RAMP_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes per step

let nodes = [];
let currentStep = 0;

const wss = new WebSocketServer({ port: PORT });
console.log(`🟢 Coordinator WebSocket running on ws://localhost:${PORT}`);

wss.on("connection", (ws) => {
  const nodeId = `node-${nodes.length + 1}`;
  nodes.push({ id: nodeId, ws, clients: 0 });
  console.log(`Node connected: ${nodeId}`);
  ws.send(JSON.stringify({ type: "register", nodeId }));

  ws.on("close", () => {
    nodes = nodes.filter((n) => n.ws !== ws);
    console.log(`Node disconnected: ${nodeId}`);
  });
});

async function rampCluster() {
  for (currentStep = 0; currentStep < FIB_SEQUENCE.length; currentStep++) {
    const totalClients = FIB_SEQUENCE[currentStep];
    let clientsPerNode = Math.floor(totalClients / nodes.length);
    let remainder = totalClients % nodes.length;

    console.log(`\n[Step ${currentStep + 1}] Target clients: ${totalClients}`);

    nodes.forEach((node, idx) => {
      let count = clientsPerNode + (idx < remainder ? 1 : 0);
      node.clients = count;
      node.ws.send(JSON.stringify({ type: "ramp", clients: count, step: currentStep }));
      console.log(`→ Node ${node.id} will spawn ${count} clients`);
    });

    await new Promise((r) => setTimeout(r, RAMP_INTERVAL_MS));
  }

  console.log("🎯 Cluster ramp complete");
}

setTimeout(rampCluster, 5000); // wait a few seconds for nodes to connect
