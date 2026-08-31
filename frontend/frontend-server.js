const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
const express = require("express");

const app = express();
const PORT = Number(process.env.UI_PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = __dirname;

app.use(express.static(path.join(ROOT, "public")));

app.use((req, res) => {
  res.sendFile(path.join(ROOT, "public", "index.html"));
});

const server = app.listen(PORT, HOST);

server.on("listening", () => {
  if (!server.address()) {
    return;
  }
  console.log(`Frontend UI running at http://${HOST}:${PORT}`);
  console.log(`Backend API expected at http://${HOST}:${process.env.API_PORT || 9090}`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `Frontend UI cannot start because http://${HOST}:${PORT} is already in use. ` +
        "Stop the existing process or set UI_PORT to another port."
    );
  } else {
    console.error(`Frontend UI failed to start: ${error.message}`);
  }
  process.exit(1);
});
