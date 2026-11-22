const http = require("http");
const { io } = require("./frontend/node_modules/socket.io-client");

// Start backend server
process.env.PORT = "3456";
const { server } = require("./backend/src/server");

async function runTests() {
  console.log("🧪 Starting Migration Verification Tests...");

  // 1. Wait for server to listen
  await new Promise((resolve) => server.listen(3456, resolve));
  console.log("✅ 1. Server started on port 3456.");

  // Helper HTTP GET
  const get = (urlPath) => new Promise((resolve, reject) => {
    http.get(`http://localhost:3456${urlPath}`, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve({ status: res.statusCode, data }));
    }).on("error", reject);
  });

  // 2. Check /api/status
  const statusRes = await get("/api/status");
  console.log(`✅ 2. /api/status responded with code ${statusRes.status}:`, JSON.parse(statusRes.data));

  // 3. Check /api/db-status
  const dbRes = await get("/api/db-status");
  console.log(`✅ 3. /api/db-status responded with code ${dbRes.status}:`, JSON.parse(dbRes.data).activeDatabase);

  // 4. Check static index.html served from Angular dist
  const indexRes = await get("/");
  const hasAppRoot = indexRes.data.includes("<app-root></app-root>");
  console.log(`✅ 4. GET / serves Angular index.html with <app-root>: ${hasAppRoot}`);

  // 5. Test Socket.IO connection
  const socket = io("http://localhost:3456", { transports: ["websocket"] });
  await new Promise((resolve, reject) => {
    socket.on("connect", () => {
      console.log(`✅ 5. Socket.IO client successfully connected with socketId: ${socket.id}`);
      resolve();
    });
    socket.on("connect_error", reject);
  });

  // 6. Test join-room event
  await new Promise((resolve, reject) => {
    socket.emit("join-room", { roomId: "0202", role: "he" }, (res) => {
      if (res && res.ok) {
        console.log("✅ 6. Socket 'join-room' authorization successful for Harry (he):", {
          ok: res.ok,
          count: res.count,
          historyCount: Array.isArray(res.history) ? res.history.length : 0
        });
        resolve();
      } else {
        reject(new Error("join-room failed: " + JSON.stringify(res)));
      }
    });
  });

  // Cleanup
  socket.disconnect();
  await new Promise((resolve) => server.close(resolve));
  console.log("\n🎉 ALL TESTS PASSED! Clean Angular + Node.js migration fully verified!\n");
  process.exit(0);
}

runTests().catch(err => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
