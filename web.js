require("dotenv").config();
const express = require("express");

const app = express();
app.use(express.json());

const PORT = Number(process.env.WEB_PORT || 10000);

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dawn Bot Control Panel</title>
<style>
body{font-family:system-ui;background:#0b0d10;color:#eee;max-width:900px;margin:40px auto;padding:20px}
.card{background:#15191f;border:1px solid #2b313a;border-radius:14px;padding:20px;margin:14px 0}
h1{margin-bottom:4px} .muted{color:#9ca3af}
.badge{display:inline-block;padding:5px 9px;border-radius:999px;background:#20252d}
</style>
</head>
<body>
<h1>Dawn Bot Control Panel</h1>
<p class="muted">CUTTHROAT • server management and feed infrastructure</p>
<div class="card"><b>Discord</b><p class="muted">Use <code>/setup</code> and <code>/feeds setup</code> inside Discord.</p></div>
<div class="card"><b>Nitrado</b><p class="muted">Use <code>/nitrado connect</code>. The token is entered through a Discord modal and is never sent as a normal channel message.</p></div>
<div class="card"><b>Feeds</b><p class="muted">Server, player, admin, community and logging feeds are supported. Trader feeds are intentionally excluded.</p></div>
<div class="card"><span class="badge">Online</span><p class="muted">Web control panel is running.</p></div>
</body>
</html>`);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "dawn-bot-web", time: new Date().toISOString() });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Dawn Bot web panel listening on ${PORT}`);
});
