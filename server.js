// Snip server: finds the loudest, most energetic moments of a YouTube video
// and cuts them into downloadable MP4 clips. Needs ffmpeg + yt-dlp installed.
const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const MAX_SEC = +process.env.MAX_VIDEO_SECONDS || 3600;   // longest video allowed
const MAX_ACTIVE = +process.env.MAX_ACTIVE_JOBS || 2;     // jobs analysed at once
const TMP = path.join(os.tmpdir(), "snip");
fs.mkdirSync(TMP, { recursive: true });

// Optional YouTube cookies (Render Secret File named cookies.txt). Copied to a
// writable place because yt-dlp tries to update the cookie file.
const COOKIES = (() => {
  const src = process.env.COOKIES_FILE || "/etc/secrets/cookies.txt";
  if (!fs.existsSync(src)) return null;
  const dst = path.join(TMP, "cookies.txt");
  fs.copyFileSync(src, dst);
  return dst;
})();

const app = express();
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));
// works whether index.html sits in /public or next to this file
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

const jobs = new Map();
const hits = new Map();
let active = 0;

function run(cmd, args) {
  if (cmd === "yt-dlp" && COOKIES) args = ["--cookies", COOKIES, ...args];
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);            // args array, no shell: no injection
    let out = "", err = "";
    p.stdout.on("data", d => (out += d));
    p.stderr.on("data", d => (err += d));
    p.on("error", () => reject(new Error(cmd + " is not installed on the server")));
    p.on("close", c => (c === 0 ? resolve(out) : reject(new Error(err.slice(-300) || cmd + " failed"))));
  });
}

function videoId(raw) {
  try {
    let u = String(raw || "").trim();
    const x = new URL(/^https?:\/\//i.test(u) ? u : "https://" + u);
    const h = x.hostname.replace(/^www\./, "").replace(/^m\./, "");
    let id = "";
    if (h === "youtu.be") id = x.pathname.slice(1).split("/")[0];
    else if (h === "youtube.com" || h === "music.youtube.com") {
      if (x.pathname === "/watch") id = x.searchParams.get("v") || "";
      else { const m = x.pathname.match(/^\/(shorts|embed|live)\/([\w-]{11})/); if (m) id = m[2]; }
    }
    return /^[\w-]{11}$/.test(id) ? id : null;
  } catch (e) { return null; }
}

const TITLES = ["Loudest moment", "Energy peak", "Big reaction", "Strong stretch", "Crowd favorite", "High point", "Standout bit", "Lively section"];

async function analyze(job) {
  const set = (stage, pct) => { job.stage = stage; job.pct = pct; };
  try {
    set("Reading the video…", 8);
    const dur = parseFloat((await run("yt-dlp", ["--no-playlist", "--print", "duration", "--", job.url])).trim());
    if (!dur) throw new Error("Couldn’t read that video. Is it public?");
    if (dur > MAX_SEC) throw new Error("That video is longer than " + Math.round(MAX_SEC / 60) + " minutes.");
    job.duration = Math.round(dur);

    set("Downloading the audio…", 25);
    await run("yt-dlp", ["--no-playlist", "-f", "ba[ext=m4a]/ba", "-o", path.join(job.dir, "audio.%(ext)s"), "--", job.url]);
    const audio = fs.readdirSync(job.dir).find(f => f.startsWith("audio."));
    if (!audio) throw new Error("Couldn’t download the audio.");

    set("Listening for the high points…", 55);
    const txt = await run("ffmpeg", ["-v", "error", "-i", path.join(job.dir, audio), "-vn", "-af",
      "aresample=16000,asetnsamples=n=16000:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
      "-f", "null", "-"]);
    const db = [...txt.matchAll(/RMS_level=(-?[\d.]+|-inf)/g)].map(m => (m[1] === "-inf" ? -90 : +m[1]));
    fs.rmSync(path.join(job.dir, audio), { force: true });
    if (db.length < job.len) throw new Error("That video is shorter than the clip length.");

    set("Scoring each moment…", 80);
    const pre = [0]; db.forEach((v, i) => pre[i + 1] = pre[i] + v);
    const wins = [];
    for (let s = 0; s + job.len <= db.length; s++) wins.push({ s, avg: (pre[s + job.len] - pre[s]) / job.len });
    const sorted = wins.slice().sort((a, b) => b.avg - a.avg);
    const picked = [];
    for (const w of sorted) {
      if (picked.length >= job.count) break;
      if (picked.every(p => Math.abs(p.s - w.s) >= job.len)) picked.push(w);
    }
    const hi = sorted[0].avg, lo = sorted[sorted.length - 1].avg || hi - 1;
    job.clips = picked.map((p, i) => ({
      start: p.s, len: job.len, title: TITLES[i % TITLES.length],
      score: Math.round(70 + 29 * (p.avg - lo) / Math.max(hi - lo, 0.001)),
    }));
    job.status = "done"; set("Done", 100);
  } catch (e) {
    job.status = "error"; job.error = e.message;
  } finally { active--; }
}

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.post("/api/jobs", (req, res) => {
  const ip = req.ip, now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < 600000);
  if (recent.length >= 6) return res.status(429).json({ error: "Too many requests. Try again in a few minutes." });
  const vid = videoId(req.body.url);
  if (!vid) return res.status(400).json({ error: "That doesn’t look like a YouTube link." });
  if (active >= MAX_ACTIVE) return res.status(503).json({ error: "The server is busy. Try again in a minute." });
  recent.push(now); hits.set(ip, recent);

  const len = [15, 30, 60].includes(+req.body.len) ? +req.body.len : 30;
  const count = Math.min(Math.max(+req.body.count || 5, 1), 8);
  const id = crypto.randomBytes(8).toString("hex");
  const dir = path.join(TMP, id);
  fs.mkdirSync(dir, { recursive: true });
  const job = { id, vid, url: "https://www.youtube.com/watch?v=" + vid, len, count, dir,
    status: "working", stage: "Starting…", pct: 3, created: now, clips: [], cuts: {} };
  jobs.set(id, job); active++;
  analyze(job);
  res.json({ id });
});

app.get("/api/jobs/:id", (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: "That job has expired. Start again." });
  res.json({ status: j.status, stage: j.stage, pct: j.pct, error: j.error, duration: j.duration, clips: j.clips });
});

app.get("/api/jobs/:id/clips/:i/download", async (req, res) => {
  const j = jobs.get(req.params.id), c = j && j.clips[+req.params.i];
  if (!c) return res.status(404).send("Clip not found or expired.");
  const out = path.join(j.dir, "clip" + req.params.i + ".mp4");
  try {
    if (!fs.existsSync(out)) {
      j.cuts[req.params.i] = j.cuts[req.params.i] || run("yt-dlp", [
        "--no-playlist", "-f", "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
        "--download-sections", "*" + c.start + "-" + (c.start + c.len),
        "--force-keyframes-at-cuts", "--merge-output-format", "mp4", "-o", out, "--", j.url]);
      await j.cuts[req.params.i];
    }
    res.download(out, "snip-" + j.vid + "-" + c.start + "s.mp4");
  } catch (e) {
    delete j.cuts[req.params.i];
    res.status(500).send("Couldn’t cut that clip: " + e.message);
  }
});

// delete finished jobs after an hour
setInterval(() => {
  const old = Date.now() - 3600000;
  for (const [id, j] of jobs) if (j.created < old) { fs.rmSync(j.dir, { recursive: true, force: true }); jobs.delete(id); }
}, 600000);

app.listen(PORT, () => console.log("Snip running on http://localhost:" + PORT));
