require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const OpenAI = require("openai");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET not defined in environment variables");
}

const app = express();
app.use(cors());
app.use(express.json());

const SECRET = process.env.JWT_SECRET;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// -----------------------------
// AUTH SETUP
// -----------------------------
const users = [
  {
    username: "admin",
    password: bcrypt.hashSync("admin123", 8),
  },
];

// -----------------------------
// CACHE (5 Minutes)
// -----------------------------
let cachedData = null;
let cacheTime = 0;

// -----------------------------
// FETCH ALL SHEETS (MULTI-TAB)
// -----------------------------
async function fetchSheetData() {
  const now = Date.now();

  if (cachedData && now - cacheTime < 5 * 60 * 1000) {
    console.log("Using cached sheet data");
    return cachedData;
  }

  console.log("Fetching fresh sheet data");

  const baseURL = `https://sheets.googleapis.com/v4/spreadsheets/${process.env.GOOGLE_SHEET_ID}`;
  const apiKey = process.env.GOOGLE_API_KEY;

  const metaResponse = await axios.get(`${baseURL}?key=${apiKey}`);
  const sheets = metaResponse.data.sheets;

  let fullData = "";

  for (let sheet of sheets) {
    const sheetName = sheet.properties.title;

    const rangeURL = `${baseURL}/values/${sheetName}!A1:Z200?key=${apiKey}`;
    const dataResponse = await axios.get(rangeURL);

    const rows = dataResponse.data.values || [];

    fullData += `\n===== SHEET: ${sheetName} =====\n`;

    rows.forEach((row) => {
      fullData += row.join(" | ") + "\n";
    });
  }

  cachedData = fullData;
  cacheTime = now;

  return fullData;
}

// -----------------------------
// LOGIN ROUTE
// -----------------------------
app.post("/login", (req, res) => {
  const { username, password } = req.body;

  const user = users.find((u) => u.username === username);

  if (!user) {
    return res.status(401).json({ error: "User not found" });
  }

  const passwordIsValid = bcrypt.compareSync(password, user.password);

  if (!passwordIsValid) {
    return res.status(401).json({ error: "Invalid password" });
  }

  const token = jwt.sign(
    { username: user.username },
    SECRET,
    { expiresIn: "1h" }
  );

  res.json({ token });
});

// -----------------------------
// AUTH MIDDLEWARE
// -----------------------------
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(403).json({ error: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    jwt.verify(token, SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// -----------------------------
// ASK ROUTE (PROTECTED)
// -----------------------------
app.post("/ask", authenticate, async (req, res) => {
  try {
    const { question } = req.body;

    if (!question) {
      return res.status(400).json({ error: "Question is required" });
    }

    const formattedData = await fetchSheetData();

    if (!formattedData.length) {
      return res.json({ answer: "No data found in sheet." });
    }

   const prompt = `
You are an AI assistant.

Answer the user's question directly and concisely.

Do NOT:
- Mention sheets
- Mention data sources
- Mention analysis process
- Explain reasoning
- Add disclaimers
- Add introductory phrases

Return only the final answer.

If the answer cannot be determined from the data, respond exactly with:
"Can't process your request (Limited computing capacity)!"

DATA:
${formattedData}

QUESTION:
${question}
`;

    const completion = await openai.chat.completions.create({
      model: "o3-mini",
      messages: [{ role: "user", content: prompt }],
    });

    const answer = completion.choices[0].message.content;

    res.json({ answer });

  } catch (error) {
    console.error("Error:", error.response?.data || error.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// -----------------------------
// START SERVER
// -----------------------------
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});