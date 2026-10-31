// Finance bot — server funksiya (Netlify Functions)
// Vazifasi: matnni AI (Gemini) orqali tahlil qiladi va Supabase bazaga yozadi.
// Kerakli sozlamalar (Netlify → Environment variables):
//   SUPABASE_URL, SUPABASE_SECRET, GEMINI_API_KEY, APP_PASSWORD
//   GEMINI_MODEL (ixtiyoriy, standart: gemini-flash-latest)

const PAYMENT_TYPES = ["naqd", "karta", "otkazma"];
// Avval tez va kam band modellar, keyin kuchliroqlari
const FALLBACK_MODELS = ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-3.5-flash", "gemini-3.8-flash"];
// Netlify funksiyasi ~10 soniyada uziladi, shuning uchun AI'ga jami 8.5 soniya beramiz
const AI_TIME_BUDGET_MS = 8500;

function checkCategories(categories) {
  if (!categories.length) {
    throw new Error(
      "Bazadan kategoriyalar o'qilmadi. SUPABASE_SECRET ga 'sb_secret_...' kaliti qo'yilganini tekshiring (publishable kalit emas)."
    );
  }
}

// ---------- Yordamchi funksiyalar ----------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function tashkentToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tashkent",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function sbHeaders(extra = {}) {
  const key = process.env.SUPABASE_SECRET || "";
  const headers = { apikey: key, "Content-Type": "application/json", ...extra };
  // Eski (legacy) service_role kalit JWT ko'rinishida bo'ladi va Authorization ham kerak
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  return headers;
}

async function sb(path, options = {}) {
  const base = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const res = await fetch(`${base}/rest/v1/${path}`, {
    ...options,
    headers: sbHeaders(options.headers),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Bazaga ulanishda xato (${res.status}): ${text}`);
  return text ? JSON.parse(text) : null;
}

function formatRow(row, kind) {
  return {
    kind,
    id: row.id,
    date: row.date,
    amount: Number(row.amount),
    category: row.categories?.name || null,
    project: row.projects?.name || null,
    payment_type: row.payment_type || null,
    note: row.note || row.source || "",
  };
}

// ---------- AI tahlil (Gemini) ----------

async function parseWithAI(message, categoryNames, projectNames, today) {
  const model = process.env.GEMINI_MODEL || "gemini-flash-latest";

  const prompt = `You extract financial transactions from a short message written in Uzbek (Latin or Cyrillic), Russian or English.
Today's date is ${today} (Asia/Tashkent timezone).

Rules:
- Each transaction is either "expense" (money spent) or "income" (money received). One message may contain several transactions.
- Amounts are in Uzbek so'm (UZS). "50 ming" / "50k" / "50 тысяч" = 50000. "1.5 mln" / "1,5 million" = 1500000.
- If an amount is in another currency (dollar, $, rubl, etc.), do NOT guess the conversion: return no items and put a short question in Uzbek into "question" asking for the amount in so'm.
- Dates: resolve relative words ("bugun", "kecha", "o'tgan dushanba", "3-noyabr") to YYYY-MM-DD. If no date is given, use today.
- "category" for expenses must be exactly one of: ${JSON.stringify(categoryNames)}. If nothing fits, use "Boshqa".
- "project" must be exactly one of: ${JSON.stringify(projectNames)}, or null if not mentioned.
- "payment_type": "naqd" (cash), "karta" (card, Click, Payme, Uzum), "otkazma" (bank transfer), or null if unknown.
- "note": a short description in Uzbek Latin, e.g. "Instagram target", "Taksi".
- If the message contains no amount at all, return an empty "items" array and a short clarifying question in Uzbek in "question".

Message: """${message}"""`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          items: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                type: { type: "STRING", enum: ["expense", "income"] },
                date: { type: "STRING" },
                amount: { type: "NUMBER" },
                category: { type: "STRING", nullable: true },
                project: { type: "STRING", nullable: true },
                payment_type: { type: "STRING", nullable: true },
                note: { type: "STRING" },
              },
              required: ["type", "date", "amount", "note"],
            },
          },
          question: { type: "STRING", nullable: true },
        },
        required: ["items"],
      },
    },
  };

  // Model band (503/429) yoki mavjud bo'lmasa (404), keyingi modelga o'tadi
  const models = [...new Set([model, ...FALLBACK_MODELS])];
  const deadline = Date.now() + AI_TIME_BUDGET_MS;
  let data = null;
  let lastError = "";
  for (let i = 0; i < models.length && !data; i++) {
    const remaining = deadline - Date.now();
    if (remaining < 1500) break;
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${models[i]}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": process.env.GEMINI_API_KEY || "",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(Math.min(remaining, 6000)),
        }
      );
      const payload = await res.json().catch(() => ({}));
      if (res.ok) {
        data = payload;
      } else {
        const msg = payload.error?.message || "noma'lum";
        lastError = `AI xatosi (${res.status}, ${models[i]}): ${msg}`;
        // Kalit xato bo'lsa, boshqa model ham yordam bermaydi
        if (res.status === 401 || res.status === 403 || /API key/i.test(msg)) throw new Error(lastError);
      }
    } catch (err) {
      if (/API key|401|403/.test(err.message)) throw err;
      lastError = `AI javob bermadi (${models[i]})`;
    }
  }
  if (!data) throw new Error((lastError || "AI band") + " — 1 daqiqadan keyin qayta urinib ko'ring.");
  const text = (data.candidates?.[0]?.content?.parts || [])
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join("");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("AI javobini o'qib bo'lmadi. Qaytadan urinib ko'ring.");
  }
}

// ---------- Amallar ----------

async function addFromText(rawText) {
  const text = String(rawText || "").trim().slice(0, 2000);
  if (!text) throw new Error("Matn bo'sh");

  const [categories, projects] = await Promise.all([
    sb("categories?select=id,name"),
    sb("projects?select=id,name"),
  ]);
  checkCategories(categories);
  const today = tashkentToday();
  const ai = await parseWithAI(
    text,
    categories.map((c) => c.name),
    projects.map((p) => p.name),
    today
  );

  const items = Array.isArray(ai.items) ? ai.items : [];
  if (!items.length) {
    return { saved: [], question: ai.question || "Summani topa olmadim. Aniqroq yozing." };
  }

  const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
  const fallbackCat = categories.find((c) => c.name === "Boshqa");
  const categoryId = (name) => (categories.find((c) => same(c.name, name)) || fallbackCat)?.id ?? null;
  const projectId = (name) => projects.find((p) => same(p.name, name))?.id ?? null;
  const validDate = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || "") ? d : today);

  const expenses = [];
  const incomes = [];
  for (const it of items) {
    const amount = Math.round(Number(it.amount) * 100) / 100;
    if (!(amount > 0)) continue;
    if (it.type === "income") {
      incomes.push({
        date: validDate(it.date),
        amount,
        project_id: projectId(it.project),
        source: it.note || null,
      });
    } else {
      expenses.push({
        date: validDate(it.date),
        amount,
        category_id: categoryId(it.category),
        project_id: projectId(it.project),
        payment_type: PAYMENT_TYPES.includes(it.payment_type) ? it.payment_type : null,
        note: it.note || null,
      });
    }
  }

  const saved = [];
  if (expenses.length) {
    const rows = await sb(
      "expenses?select=id,date,amount,note,payment_type,categories(name),projects(name)",
      { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(expenses) }
    );
    saved.push(...rows.map((r) => formatRow(r, "expense")));
  }
  if (incomes.length) {
    const rows = await sb("incomes?select=id,date,amount,source,projects(name)", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(incomes),
    });
    saved.push(...rows.map((r) => formatRow(r, "income")));
  }
  return { saved, question: saved.length ? null : "Summani aniqlay olmadim." };
}

async function summary() {
  const today = tashkentToday();
  const monthStart = today.slice(0, 8) + "01";

  const [expenses, incomes, categories] = await Promise.all([
    sb(`expenses?select=id,date,amount,note,payment_type,categories(name),projects(name)&date=gte.${monthStart}&order=date.desc,id.desc`),
    sb(`incomes?select=id,date,amount,source,projects(name)&date=gte.${monthStart}&order=date.desc,id.desc`),
    sb("categories?select=name,monthly_limit&order=name"),
  ]);

  checkCategories(categories);
  const spentBy = {};
  for (const e of expenses) {
    const name = e.categories?.name || "Boshqa";
    spentBy[name] = (spentBy[name] || 0) + Number(e.amount);
  }
  const byCategory = categories
    .map((c) => ({ name: c.name, spent: spentBy[c.name] || 0, limit: Number(c.monthly_limit) || 0 }))
    .sort((a, b) => b.spent - a.spent);

  const recent = [
    ...expenses.map((r) => formatRow(r, "expense")),
    ...incomes.map((r) => formatRow(r, "income")),
  ]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id))
    .slice(0, 30);

  return {
    month: monthStart.slice(0, 7),
    totalExpense: expenses.reduce((s, e) => s + Number(e.amount), 0),
    totalIncome: incomes.reduce((s, e) => s + Number(e.amount), 0),
    byCategory,
    recent,
  };
}

async function removeRow(kind, id) {
  const table = kind === "income" ? "incomes" : "expenses";
  const rowId = parseInt(id, 10);
  if (!Number.isInteger(rowId)) throw new Error("Noto'g'ri ID");
  await sb(`${table}?id=eq.${rowId}`, { method: "DELETE" });
  return { ok: true };
}

// ---------- Asosiy kirish nuqtasi ----------

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Faqat POST so'rov qabul qilinadi" }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Noto'g'ri so'rov" }, 400);
  }

  if (!process.env.APP_PASSWORD || body.password !== process.env.APP_PASSWORD) {
    return json({ error: "Parol noto'g'ri" }, 401);
  }

  try {
    switch (body.action) {
      case "login":
        return json({ ok: true });
      case "add":
        return json(await addFromText(body.text));
      case "summary":
        return json(await summary());
      case "delete":
        return json(await removeRow(body.kind, body.id));
      default:
        return json({ error: "Noma'lum amal" }, 400);
    }
  } catch (err) {
    return json({ error: err.message }, 500);
  }
};

export const config = { path: "/api" };
