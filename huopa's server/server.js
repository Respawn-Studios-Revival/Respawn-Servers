// [Imports]

import express from "npm:express";
import rateLimit from "npm:express-rate-limit";
import bcrypt from "npm:bcryptjs";
import crypto from "node:crypto";
import path from "node:path";
import jwt from "npm:jsonwebtoken";
import cookieParser from "npm:cookie-parser";


// [Setup]
const PRODUCTION = false;
const serverUrl = "http://localhost:5173/";
const port = 5173;
const app = express();

app.use(express.static(path.join(process.cwd(), "public")));

const kv = await Deno.openKv();

const limiter = rateLimit({
  windowMs: 1000 * 60,
  max: 100,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  ipv6Subnet: 64,
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(limiter);
app.use(cookieParser());
let JWT_SECRET
if (Deno.env.get("JWT_SECRET")) {
  JWT_SECRET = Deno.env.get("JWT_SECRET")
} else {
  console.log(`No JWT Secret! Add "JWT_SECRET" to your environment variables with the data "${crypto.randomBytes(32).toString("hex")}" (MAKE SURE TO SAVE THIS VARIABLE SOMEWHERE!)`);
  process.exit();
}

Deno.env.set("JWT_SECRET", JWT_SECRET);
const COOKIE_NAME = "respawn_token";

// [API Data]

let projects = [];
let accountDB = [];
let blockedIps = [];
projects = await loadProjects();
accountDB = await loadAccounts();
blockedIps = await loadBans()

// [CORS]

app.use((req, res, next) => {
  if (blockedIps.includes(req.ip)) return res.status(403).send("Your IP address has been banned.");
  const origin = req.headers.origin;
  if (origin) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
  } else {
    res.header("Access-Control-Allow-Origin", "*");
  }

  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// [Endpoints]

async function dashboard(req, res, method) {
  if (method === "GET") {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return res.redirect("dashboardAdminLogin.html");

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
      if (req.user.type !== "admin") return res.redirect("dashboardAdminLogin.html");

      return res.sendFile(path.join(process.cwd(), "public", "dashboardAdmin.html"));
    } catch {
      return res.redirect("dashboardAdminLogin.html");
    }
  } else if (method === "POST") {
    if (req.user.type !== "admin") return res.status(403).send("Admin required");

    return res.json({
      user: req.user,
      projects,
      accounts: accountDB,
    });
  }
}

async function signup(req, res, method) {
  if (method === "GET") {
    return res.redirect("signup.html");
  } else if (method === "POST") {
    const { username, password } = req.body;
    const regex = /[^A-Za-z0-9\-.,/+*]/;
    if (!username || !password || password.toString().length < 3 || username.toString().length < 3) {
      return res.sendStatus(400);
    }
    if (typeof username != "string") return res.status(400).send("Invalid type for username");
    if (regex.test(username.toLowerCase())) return res.status(400).send("Characters not allowed!");

    if (accountDB.some((p) => p.username.toLowerCase() === username.toLowerCase())) {
      return res.status(403).send("Username already taken.");
    }

    const hashed = await bcrypt.hash(password, 10);
    const account = {
      id: crypto.randomUUID(),
      displayname: username,
      username,
      password: hashed,
      type: "user",
      ip: req.ip
    };
    accountDB.push(account);
    await saveAccounts();

    return res.redirect("signupSuccess.html");
  }
}

async function login(req, res, method) {
  if (method === "GET") {
    return res.redirect("login.html");
  } else if (method === "POST") {
    const { username, password } = req.body;
    if (!username || !password || password.toString().length < 3 || username.toString().length < 3) {
      return res.sendStatus(400);
    }

    const accountI = accountDB.findIndex((u) => u.username === username);
    const account = accountDB[accountI];
    if (!account) return res.status(403).send("Invalid credentials");
    accountDB[accountI].ip = req.ip;
    const valid = await bcrypt.compare(password, account.password);
    if (!valid) return res.status(403).send("Invalid credentials");
    const token = createToken(account);
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      maxAge: 90 * 24 * 60 * 60 * 1000,
    });

    return res.json({ success: true, user: account.username });
  }
}

async function API(req, res, method) {
  const admin = req.user?.type === "admin";
  if (method === "GET") {
    const type = req.query?.type;
    switch (type) {
      case "getAccountObject":
        return res.status(200).json({username: req.user.username, display: req.user.displayname, id: req.user.id, type: req.user.type});
        break;
      case "getLevelData":
        let id = req.query?.id;
        if (!id) return res.status(400).json({ error: "Level ID required to get level data" });
        const index = projects.findIndex(u => u.id === id);
        if (index !== -1)  return res.status(200).json(projects[index]);
        return res.status(404).json({ error: "Requested level doesn't exist" });
      default:
        return res.status(400).json({ error: "Unknown API request" });
        break;
    }
  } else if (method === "POST") {
    const type = req.body?.type;
    const data = req.body?.data;
    switch (type) {
      case "changeDisplayName":
        if (typeof data != "string") return res.status(400).json({ error: "Invalid type for display name!" });
        const targetUsername = req.user.username;
        const index = accountDB.findIndex(u => u.username === targetUsername);
        let accData = accountDB[index];
        accData.displayname = data;
        if (index !== -1) {
          accountDB[index] = accData;
          return res.status(200).json({ info: `Set account display name to ${JSON.stringify(data)}` });
        } else {
          return res.status(404).json({ error: "Account not found" });
        }
        break;
      case "uploadLevel":
        try {
          if (typeof data != "object") return res.status(400).json({ error: "Malformed request payload" });
          if (!data?.name || data.name.length < 3) return res.status(400).json({ error: "Your game name must be at least 3 characters" });
          let desc = data.description || "";
          projects.push({
            id: projects.length,
            creator: req.user.username,
            name: data.name,
            description: desc,
            gamedata: data.gamedata
          });
          saveProjects();
        } catch (error) {
          return res.status(500).json({ error: "Internal server error" });
        }
        break;
      default:
        if (admin) {
          switch (type) {
            case "setAccountData": {
              const targetUsername = data.username;
              if (!targetUsername) {
                return res.status(400).json({ error: "Username is required" });
              }

              const index = accountDB.findIndex(u => u.username === targetUsername);
              if (index !== -1) {
                accountDB[index] = { ...accountDB[index], ...data };

                await saveAccounts();
                return res.json({ success: true, account: accountDB[index] });
              } else {
                return res.status(404).json({ error: "Account not found" });
              }
            }

            case "getAccountData":{
              const index = accountDB.findIndex(u => u.id === req.user.id);
              if (index !== -1) {
                return res.json(accountDB[index])
              }
              return res.status(404).json({ error: "Account not found" });
              break;
            }
            case "getAccountList":
              return res.json(accountDB);
            case "deleteUser":
              const index = accountDB.findIndex(u => u.id === data.id);
              const blockIp = req.body?.blockIp;
              if (index !== -1) {
                if (blockIp) { blockedIps.push(accountDB[index].ip); saveBans(); };
                accountDB.splice(index, 1);
                saveAccounts();
                return res.status(200).json({ success: true, message: "User deleted" });
              }
              return res.status(404).json({ error: "Account not found" });
            default:
              return res.status(400).json({ error: "Unknown API request" });
              break;
          }
        } else {
          return res.status(400).json({ error: "Unknown API request" });
        }
    }
  }
}


// [Routes]
app.post("/signup", (req, res) => signup(req, res, "POST"));
app.get("/signup", (req, res) => signup(req, res, "GET"));
app.post("/login", (req, res) => login(req, res, "POST"));
app.get("/login", (req, res) => login(req, res, "GET"));
app.get("/dashboard", (req, res) => dashboard(req, res, "GET"));
app.post("/dashboard", checkToken, (req, res) => dashboard(req, res, "POST"));
app.get("/api", checkToken, (req, res) => API(req, res, "GET"));
app.post("/api", checkToken, (req, res) => API(req, res, "POST"));
app.post("/logout", (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ success: true });
});

app.listen(port, () => console.log("Proxy running on " + serverUrl));

// [Helpers]

function createToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, type: user.type },
    JWT_SECRET,
    { expiresIn: "90d" }
  );
}

function checkToken(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).send("Not authenticated");

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    const index = accountDB.findIndex(u => u.id === decoded.id);
    if (index === -1) return res.status(403).send("Your account does not exist");
    req.user = decoded;
    next();
  } catch {
    return res.status(401).send("Invalid or expired token");
  }
}

async function saveAccounts() {
  await kv.set(["accounts"], JSON.stringify(accountDB));
}
async function saveBans() {
  await kv.set(["bannedIps"], JSON.stringify(blockedIps));
}
async function loadAccounts() {
  const result = await kv.get(["accounts"]);
  try {
    return result?.value ? JSON.parse(result.value) : [];
  } catch (error) {
    return result.value
  }
}
async function saveProjects() {
  await kv.set(["projects"], JSON.stringify(projects));
}
async function loadProjects() {
  const result = await kv.get(["projects"]);
  return result?.value ? JSON.parse(result.value) : [];
}
async function loadBans() {
  const banRes = await kv.get(["bannedIps"]);
  try {
    return banRes?.value ? JSON.parse(banRes.value) : [];
  } catch (error) {
    return banRes.value
  }
}