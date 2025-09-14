// server.js
// Run with: node server.js   (or: npm run dev)

const express = require("express");
const cors = require("cors");
const path = require("path");
const { randomUUID } = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

const staticDir = path.join(__dirname, "public");
app.use((req, _res, next) => { console.log(`[REQ] ${req.method} ${req.url}`); next(); });
app.use(express.static(staticDir));

// ---------- utils ----------
const fetchFx = global.fetch
  ? (...args) => fetch(...args)
  : (...args) => import("node-fetch").then(m => m.default(...args));

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const prOrder = { high: 0, medium: 1, low: 2 };

function prioritizeTasks(tasks) {
  return tasks.slice().sort((a, b) => {
    const da = a.due ? Date.parse(a.due) : Infinity;
    const db = b.due ? Date.parse(b.due) : Infinity;
    if (da !== db) return da - db;
    const pa = prOrder[a.priority || "medium"], pb = prOrder[b.priority || "medium"];
    if (pa !== pb) return pa - pb;
    return (a.duration_min ?? 25) - (b.duration_min ?? 25);
  });
}

function sessionBlocks(minutes, tasks, work = 25, short = 5, long = 15, longEvery = 4) {
  let m = Math.max(0, Math.floor(minutes));
  const blocks = [];
  let pomCount = 0;

  const queue = tasks.map(t => {
    const need = Math.max(1, Math.ceil((t.duration_min ?? work) / work));
    return { ...t, remaining: need };
  });

  outer: while (m >= work) {
    const t = queue.find(x => x.remaining > 0);
    if (!t) break;

    // Work block
    blocks.push({ id: randomUUID(), type: "work", seconds: work * 60, taskId: t.id, title: t.title });
    t.remaining -= 1;
    m -= work;
    pomCount += 1;

    // Break only if time remains for break + another work
    const breakLen = (pomCount % longEvery === 0) ? long : short;
    if (m >= breakLen + work) {
      blocks.push({ id: randomUUID(), type: "break", seconds: breakLen * 60 });
      m -= breakLen;
    } else {
      break outer;
    }
  }
  return blocks;
}

// ---------- AI: Ollama weekly parser (with fallback) ----------
async function parseWeeklyBriefWithOllama(briefText) {
  const prompt = `
Convert the weekly brief to JSON.

Schema EXACTLY:
{ "tasks": [ { "title": string, "due": string|null, "duration_min": number|null, "priority": "low"|"medium"|"high", "tags": string[] } ] }

Rules:
- Weekdays (Mon/Tue/...) -> use the NEXT occurrence as ISO YYYY-MM-DD.
- "~45min" or "~90m" -> duration_min (number). If none, null.
- Infer priority if obvious; default "medium".
- Tags from #hashtags.

Brief:
"""${briefText}"""
Return ONLY JSON.
`.trim();

  const resp = await fetchFx("http://127.0.0.1:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen2.5:3b",     // ensure you've pulled this: `ollama pull qwen2.5:3b`
      prompt,
      stream: false,
      options: { temperature: 0.2 }
    })
  });

  if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${await resp.text()}`);
  const envelope = await resp.json();        // { response: "<JSON string>", ... }
  const ai = JSON.parse(envelope.response);  // -> { tasks: [...] }
  return ai;
}

// Deterministic fallback parser
function heuristicWeeklyParse(text) {
  const lines = (text || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const dow = {
    sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6,
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6
  };
  const upcomingDow = (d) => {
    const now = new Date(); now.setHours(0, 0, 0, 0);
    const delta = (d - now.getDay() + 7) % 7 || 7;
    const out = new Date(now); out.setDate(now.getDate() + delta);
    return out.toISOString().slice(0, 10);
  };

  return {
    tasks: lines.map(line => {
      const id = randomUUID();
      const dur = line.match(/~\s*(\d+)\s*(m|min)\b/i);
      const duration_min = dur ? clamp(parseInt(dur[1], 10), 5, 480) : null;
      const pr = line.match(/\b(low|medium|high)\b/i);
      const priority = pr ? pr[1].toLowerCase() : "medium";
      const tags = Array.from(line.matchAll(/#([\w-]+)/g)).map(m => m[1].toLowerCase());

      let due = null;
      const dueTok = line.match(/\bdue\s+([A-Za-z0-9-]+)\b/i);
      const wkTok = line.match(/\b(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
      if (dueTok) {
        const tok = dueTok[1].toLowerCase();
        if (/^\d{4}-\d{2}-\d{2}$/.test(tok)) due = tok;
        else if (tok in dow) due = upcomingDow(dow[tok]);
      } else if (wkTok) {
        const tok = wkTok[0].toLowerCase();
        if (tok in dow) due = upcomingDow(dow[tok]);
      }

      let title = line
        .replace(/~\s*\d+\s*(m|min)\b/ig, "")
        .replace(/\b(low|medium|high)\b/ig, "")
        .replace(/\bdue\s+[A-Za-z0-9-]+\b/ig, "")
        .replace(/#[\w-]+/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();
      if (!title) title = line;

      return { id, title, due, priority, duration_min, tags };
    })
  };
}

// ---------- In-memory stores ----------
let TASKS = [];                // {id,title,due,duration_min,priority,tags,done:boolean}
let CURRENT_PLAN = [];         // [{id,type,seconds,taskId?,title?}]

// ---------- TASKS API (checklist) ----------
app.get("/api/tasks", (_req, res) => res.json({ tasks: TASKS }));

app.post("/api/tasks", (req, res) => {
  const { title, due = null, duration_min = 25, priority = "medium", tags = [] } = req.body ?? {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: "title required" });
  const task = { id: randomUUID(), title: String(title).trim(), due, duration_min, priority, tags, done: false };
  TASKS.push(task);
  res.json({ task, tasks: TASKS });
});

app.patch("/api/tasks/:id", (req, res) => {
  const i = TASKS.findIndex(t => t.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "not found" });
  TASKS[i] = { ...TASKS[i], ...req.body };
  res.json({ task: TASKS[i], tasks: TASKS });
});

app.delete("/api/tasks/:id", (req, res) => {
  const i = TASKS.findIndex(t => t.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "not found" });
  const removed = TASKS.splice(i, 1)[0];
  res.json({ removed, tasks: TASKS });
});

// ---------- AI weekly parse ----------
app.post("/api/ai/weekly-parse", async (req, res) => {
  const { text } = req.body ?? {};
  if (!text) return res.status(400).json({ error: "text required" });

  try {
    const ai = await parseWeeklyBriefWithOllama(text);
    const normalized = (ai.tasks || []).map(t => ({
      id: randomUUID(),
      title: String(t.title || "").trim(),
      due: t.due ?? null,
      duration_min: t.duration_min ?? 25,
      priority: (t.priority || "medium").toLowerCase(),
      tags: Array.isArray(t.tags) ? t.tags : [],
      done: false
    }));
    TASKS = normalized;
    res.json({ source: "ollama", tasks: normalized });
  } catch (e) {
    console.warn("Ollama failed, using heuristic:", e.message || e);
    const { tasks } = heuristicWeeklyParse(text);
    const normalized = tasks.map(t => ({
      ...t,
      duration_min: t.duration_min ?? 25,
      priority: t.priority || "medium",
      tags: t.tags || [],
      done: false
    }));
    TASKS = normalized;
    res.json({ source: "heuristic", tasks: normalized, warning: String(e.message || e) });
  }
});

// ---------- PLAN API (generate, get, update editable plan) ----------
app.post("/api/plan/generate", (req, res) => {
  const { minutesAvailable, work = 25, short = 5, long = 15, longEvery = 4 } = req.body ?? {};
  if (!(minutesAvailable > 0)) return res.status(400).json({ error: "minutesAvailable required" });
  if (!TASKS.length) return res.status(400).json({ error: "no tasks to plan (add or parse tasks first)" });

  const prioritized = prioritizeTasks(TASKS);
  CURRENT_PLAN = sessionBlocks(minutesAvailable, prioritized, work, short, long, longEvery);
  res.json({ blocks: CURRENT_PLAN });
});

app.get("/api/plan", (_req, res) => res.json({ blocks: CURRENT_PLAN }));

app.put("/api/plan", (req, res) => {
  const { blocks } = req.body ?? {};
  if (!Array.isArray(blocks)) return res.status(400).json({ error: "blocks array required" });
  // sanitize
  CURRENT_PLAN = blocks.map(b => ({
    id: b.id || randomUUID(),
    type: b.type === "break" ? "break" : "work",
    seconds: clamp(parseInt(b.seconds, 10) || 0, 60, 8 * 3600),
    taskId: b.taskId || null,
    title: b.title || null
  }));
  res.json({ blocks: CURRENT_PLAN });
});

// ---------- root ----------
app.get("/", (_req, res) => res.sendFile(path.join(staticDir, "index.html")));
/*
const server = app.listen(3000, "127.0.0.1", () => {
  const addr = server.address();
  console.log(`✅ Backend listening on http://${addr.address}:${addr.port}`);
});*/

const PORT = 3000;

app.listen(PORT, () => {
  console.log(`✅ Backend listening on http://localhost:${PORT}`);
});

/*const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

const staticDir = path.join(__dirname, "public");

// log requests so we can see what hits
app.use((req, _res, next) => {
  console.log("[REQ]", req.method, req.url);
  next();
});

// serve static files (CSS/JS/images + index.html)
app.use(express.static(staticDir));

// serve the main page at /
app.get("/", (req, res) => {
  res.sendFile(path.join(staticDir, "index.html"));
});

const server = app.listen(3000, "127.0.0.1", () => {
  const addr = server.address();
  console.log(`✅ Backend listening on ${addr.address}:${addr.port}`);
});


*/