// Finance bot — server funksiya (Netlify Functions) — v5 (1: hisoblar va valyuta; 2: chek rasmi va ovoz; 3: grafiklar, budjet limiti, loyiha foydasi; 4: AI maslahatchi, haftalik xulosa, g'alati xarajat)
// Vazifasi: matnni AI (Gemini) orqali tahlil qiladi va Supabase bazaga yozadi.
// Kerakli sozlamalar (Netlify → Environment variables):
//   SUPABASE_URL, SUPABASE_SECRET, GEMINI_API_KEY, APP_PASSWORD
//   GEMINI_MODEL (ixtiyoriy, standart: gemini-flash-latest)
// Bazada kerak: 1-bosqich-hisoblar.sql (accounts, transfers, rates jadvallari)
 
const PAYMENT_TYPES = ["naqd", "karta", "otkazma"];
const CURRENCIES = ["UZS", "USD", "EUR", "RUB"];
const ACCOUNT_KINDS = ["naqd", "karta", "bank"];
// Avval tez va kam band modellar, keyin kuchliroqlari
const FALLBACK_MODELS = ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-3.5-flash", "gemini-3.8-flash"];
// Netlify funksiyasi ~10 soniyada uziladi, shuning uchun AI'ga jami 8 soniya beramiz
const AI_TIME_BUDGET_MS = 8500;
// Rasm/ovoz hajmi chegarasi (base64) — Netlify so'rov chegarasi 6 MB
const MAX_MEDIA_B64 = 4_500_000;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const AUDIO_TYPES = ["audio/wav", "audio/mp3", "audio/mpeg", "audio/ogg", "audio/aac", "audio/flac", "audio/webm", "audio/mp4"];
 
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
  if (!res.ok) {
    if (/accounts|transfers|rates|account_id|currency/.test(text) && /does not exist|Could not find/i.test(text)) {
      throw new Error("Bazada hisoblar jadvali yo'q — Supabase SQL Editor'da '1-bosqich-hisoblar.sql' ni ishga tushiring.");
    }
    throw new Error(`Bazaga ulanishda xato (${res.status}): ${text}`);
  }
  return text ? JSON.parse(text) : null;
}
 
const num = (v) => Number(v) || 0;
const round2 = (v) => Math.round(num(v) * 100) / 100;
const same = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
 
// ---------- Valyuta kursi (Markaziy bank → zaxira manbalar), kuniga bir marta bazaga saqlanadi ----------
 
async function fetchJson(url, ms) {
  const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (FinanceBot)" }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(url.split("/")[2] + " " + r.status);
  return r.json();
}
 
async function liveRate(code) {
  try {
    const d = (await fetchJson(`https://cbu.uz/uz/arkhiv-kursov-valyut/json/${code}/`, 2500))[0];
    if (d && d.Rate) return Number(d.Rate) / (Number(d.Nominal) || 1);
  } catch {}
  try {
    const low = code.toLowerCase();
    const d = await fetchJson(`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${low}.min.json`, 2000);
    const v = d && d[low] && Number(d[low].uzs);
    if (v) return v;
  } catch {}
  return 0;
}
 
// Bugungi kurslar: {USD: 12850, EUR: ..., RUB: ...}. Bazada bo'lmasa — Markaziy bankdan olib saqlaydi.
async function getRates(today, need = ["USD", "EUR", "RUB"]) {
  const out = { UZS: 1 };
  let rows = [];
  try { rows = (await sb(`rates?select=ccy,date,rate&order=date.desc&limit=30`)) || []; } catch {}
  for (const c of need) {
    const todayRow = rows.find((r) => r.ccy === c && r.date === today);
    if (todayRow) { out[c] = num(todayRow.rate); continue; }
    const v = await liveRate(c);
    if (v) {
      out[c] = v;
      sb("rates", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify([{ ccy: c, date: today, rate: v }]) }).catch(() => {});
    } else {
      const last = rows.find((r) => r.ccy === c); // internet ishlamasa — oxirgi saqlangan kurs
      if (last) out[c] = num(last.rate);
    }
  }
  return out;
}
 
function formatRow(row, kind, accounts = []) {
  const acc = accounts.find((a) => a.id === row.account_id);
  return {
    kind,
    id: row.id,
    date: row.date,
    amount: num(row.amount),
    currency: row.currency || "UZS",
    uzs: round2(num(row.amount) * (num(row.rate) || 1)),
    category: row.categories?.name || null,
    project: row.projects?.name || null,
    payment_type: row.payment_type || null,
    account: acc ? acc.name : null,
    note: row.note || row.source || "",
  };
}
 
function formatTransfer(t, accounts) {
  const f = accounts.find((a) => a.id === t.from_account), to = accounts.find((a) => a.id === t.to_account);
  return {
    kind: "transfer",
    id: t.id,
    date: t.date,
    amount: num(t.amount),
    currency: f ? f.currency : "UZS",
    to_amount: num(t.to_amount),
    to_currency: to ? to.currency : "UZS",
    from: f ? f.name : "?",
    to: to ? to.name : "?",
    note: t.note || "",
  };
}
 
// ---------- AI (Gemini) ----------
 
// Gemini'ga so'rov: model band (503/429) yoki mavjud bo'lmasa (404) — keyingi modelga o'tadi. Matn qaytaradi.
async function callGemini(body, long = false) {
  const model = process.env.GEMINI_MODEL || "gemini-flash-latest";
  const models = [...new Set([model, ...FALLBACK_MODELS])];
  const deadline = Date.now() + AI_TIME_BUDGET_MS;
  let data = null;
  let lastError = "";
  for (let i = 0; i < models.length && !data; i++) {
    const remaining = deadline - Date.now();
    if (remaining < 1500) break;
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${models[i]}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY || "" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(long ? remaining : Math.min(remaining, 6000)),
      });
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
  return (data.candidates?.[0]?.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join("");
}
 
async function parseWithAI(message, categoryNames, projectNames, accounts, today, media = null) {
  const accList = accounts.map((a) => `${a.name} (${a.currency}, ${a.kind})`);
 
  const prompt = `You extract financial transactions from a short message written in Uzbek (Latin or Cyrillic), Russian or English.
Today's date is ${today} (Asia/Tashkent timezone).
 
Rules:
- Each item is "expense" (money spent), "income" (money received) or "transfer" (money moved between the user's OWN accounts: cash withdrawal from card, topping up a card, exchanging dollars to so'm, etc. — a transfer is NOT an expense or income). One message may contain several items.
- "amount" is a number in the item's own currency. "50 ming" / "50k" / "50 тысяч" = 50000. "1.5 mln" / "1,5 million" = 1500000.
- "currency": "UZS" (so'm, default), "USD" ($, dollar, доллар), "EUR" (yevro), "RUB" (rubl). Do NOT convert currencies yourself.
- "account": the user's account the money left (expense/transfer) or arrived to (income), exactly one of: ${JSON.stringify(accList.map((x) => x.replace(/ \(.*$/, "")))}. Details: ${JSON.stringify(accList)}. Match by name or by hint ("kartadan" → a karta account of that currency, "naqd" → a naqd account, "$" → a USD account). If unclear, null.
- For "transfer": "account" = from account, "to_account" = destination account (same list). "to_amount" = amount that arrived, only if the message says it (e.g. "100$ ni 1 280 000 so'mga almashtirdim" → amount 100 USD, to_amount 1280000); otherwise null.
- Dates: resolve relative words ("bugun", "kecha", "o'tgan dushanba", "3-noyabr") to YYYY-MM-DD. If no date is given, use today.
- "category" (expenses only) must be exactly one of: ${JSON.stringify(categoryNames)}. If nothing fits, use "Boshqa".
- "project" must be exactly one of: ${JSON.stringify(projectNames)}, or null if not mentioned.
- "payment_type": "naqd" (cash), "karta" (card, Click, Payme, Uzum), "otkazma" (bank transfer), or null if unknown.
- "note": a short description in Uzbek Latin, e.g. "Instagram target", "Taksi", "Kartadan naqd yechildi".
- If neither the message nor the attached image/audio contains an amount, return an empty "items" array and a short clarifying question in Uzbek in "question".
${media && media.kind === "image" ? `
AN IMAGE IS ATTACHED. It is usually a shop receipt (chek), a bank/Click/Payme/Uzum app screenshot or a card SMS screenshot.
- Record the TOTAL paid amount ("Итого", "Jami", "Всего", "Summa", "К оплате") as ONE expense, not every line — unless the image clearly shows several separate payments (e.g. a list of card transactions), then one item per payment.
- "note": the shop / merchant / recipient name and 1–3 words about what was bought (Uzbek Latin), e.g. "Korzinka — oziq-ovqat".
- Date from the image if visible (and not in the future), otherwise today. Card or cash: from the image if visible (karta, naqd, "Uzcard", "Humo", "Visa"); bank app screenshots mean karta.
- Incoming transfers / salary credited on the screenshot are "income".
- Choose the category from the shop type (supermarket/cafe → food-like category, taxi/fuel → transport, etc.).
- If the image is not financial or unreadable — empty "items" and a short question in Uzbek. Never invent amounts.
- The typed message (if any) adds context and has priority (e.g. "Jarvis loyihasi uchun", "Humo kartadan").` : ""}${media && media.kind === "audio" ? `
AN AUDIO (voice message) IS ATTACHED, usually in Uzbek (may mix Russian/English words). First write exactly what was said into "transcript" (Uzbek Latin script), then extract transactions from it using the rules above. If nothing is said or it is not about money — empty "items" and a short question in Uzbek.` : ""}
 
Message: """${message || (media ? "(rasm yoki ovozga qarang)" : "")}"""`;
 
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }, ...(media ? [{ inline_data: { mime_type: media.mime, data: media.data } }] : [])] }],
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
                type: { type: "STRING", enum: ["expense", "income", "transfer"] },
                date: { type: "STRING" },
                amount: { type: "NUMBER" },
                currency: { type: "STRING", enum: CURRENCIES },
                account: { type: "STRING", nullable: true },
                to_account: { type: "STRING", nullable: true },
                to_amount: { type: "NUMBER", nullable: true },
                category: { type: "STRING", nullable: true },
                project: { type: "STRING", nullable: true },
                payment_type: { type: "STRING", nullable: true },
                note: { type: "STRING" },
              },
              required: ["type", "date", "amount", "currency", "note"],
            },
          },
          question: { type: "STRING", nullable: true },
          transcript: { type: "STRING", nullable: true },
        },
        required: ["items"],
      },
    },
  };
 
  const text = await callGemini(body, !!media);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("AI javobini o'qib bo'lmadi. Qaytadan urinib ko'ring.");
  }
}
 
// Hisobni tanlash: AI aytgan nom → to'lov turi va valyutaga mos hisob → shu valyutadagi birinchi hisob
function pickAccount(accounts, name, currency, paymentType) {
  const active = accounts.filter((a) => !a.archived);
  const byName = active.find((a) => same(a.name, name));
  if (byName) return byName;
  const ofCur = active.filter((a) => a.currency === currency);
  const kind = paymentType === "naqd" ? "naqd" : paymentType === "karta" ? "karta" : paymentType === "otkazma" ? "bank" : null;
  return (kind && ofCur.find((a) => a.kind === kind)) || ofCur[0] || null;
}
 
// ---------- Amallar ----------
 
function checkMedia(b) {
  const m = b && (b.image || b.audio);
  if (!m) return null;
  const kind = b.image ? "image" : "audio";
  const mime = String(m.mime || "").toLowerCase().split(";")[0];
  const data = String(m.data || "").replace(/^data:[^,]+,/, "");
  if (!data) throw new Error(kind === "image" ? "Rasm bo'sh" : "Ovoz bo'sh");
  if (data.length > MAX_MEDIA_B64) throw new Error(kind === "image" ? "Rasm juda katta — kichikroq rasm yuboring" : "Ovoz juda uzun — 1 daqiqagacha gapiring");
  if (kind === "image" && !IMAGE_TYPES.includes(mime)) throw new Error("Rasm turi: JPG, PNG yoki WEBP");
  if (kind === "audio" && !AUDIO_TYPES.includes(mime)) throw new Error("Ovoz turi qo'llab-quvvatlanmaydi: " + mime);
  return { kind, mime, data };
}
 
async function addFromText(rawText, media = null) {
  const text = String(rawText || "").trim().slice(0, 2000);
  if (!text && !media) throw new Error("Matn bo'sh");
 
  const today = tashkentToday();
  const [categories, projects, accounts] = await Promise.all([
    sb("categories?select=id,name"),
    sb("projects?select=id,name"),
    sb("accounts?select=id,name,currency,kind,archived&order=id"),
  ]);
  checkCategories(categories);
  // Kursni AI bilan bir vaqtda olamiz (vaqtni tejash uchun)
  const ratesP = getRates(today).catch(() => ({ UZS: 1 }));
  const ai = await parseWithAI(text, categories.map((c) => c.name), projects.map((p) => p.name), accounts.filter((a) => !a.archived), today, media);
  const rates = await ratesP;
  const transcript = media && media.kind === "audio" ? String(ai.transcript || "").trim().slice(0, 1000) : null;
 
  const items = Array.isArray(ai.items) ? ai.items : [];
  if (!items.length) return { saved: [], transcript, question: ai.question || (media && media.kind === "image" ? "Rasmda summani topa olmadim. Aniqroq rasm yuboring yoki summani yozing." : "Summani topa olmadim. Aniqroq yozing.") };
 
  const fallbackCat = categories.find((c) => c.name === "Boshqa");
  const categoryId = (name) => (categories.find((c) => same(c.name, name)) || fallbackCat)?.id ?? null;
  const projectId = (name) => projects.find((p) => same(p.name, name))?.id ?? null;
  const validDate = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || "") && d <= today ? d : today);
  const notes = [];
 
  const expenses = [], incomes = [], transfers = [];
  for (const it of items) {
    const amount = round2(it.amount);
    if (!(amount > 0)) continue;
    const pt = PAYMENT_TYPES.includes(it.payment_type) ? it.payment_type : null;
    let cur = CURRENCIES.includes(it.currency) ? it.currency : "UZS";
    const acc = pickAccount(accounts, it.account, cur, pt);
    if (it.type === "transfer") {
      const to = pickAccount(accounts, it.to_account, null, null);
      if (!acc || !to || acc.id === to.id) { notes.push(`O'tkazma uchun hisoblar aniq emas: "${it.note}". Masalan: "Uzcarddan naqd so'mga 500 ming yechdim".`); continue; }
      let toAmount = round2(it.to_amount);
      if (!(toAmount > 0)) {
        if (acc.currency === to.currency) toAmount = amount;
        else {
          const rf = rates[acc.currency], rt = rates[to.currency];
          if (!rf || !rt) { notes.push(`Kurs topilmadi — o'tkazmada qancha tushganini ham yozing: "${it.note}".`); continue; }
          toAmount = round2((amount * rf) / rt);
        }
      }
      transfers.push({ date: validDate(it.date), from_account: acc.id, to_account: to.id, amount, to_amount: toAmount, note: it.note || null });
      continue;
    }
    let amt = amount, note = it.note || null;
    if (!rates[cur]) { notes.push(`${cur} kursini ololmadim — "${it.note}" yozilmadi, keyinroq qayta urinib ko'ring.`); continue; }
    // Hisob boshqa valyutada bo'lsa (masalan so'mli kartadan 20$ to'lov) — summa hisob valyutasiga o'giriladi
    if (acc && acc.currency !== cur) {
      if (!rates[acc.currency]) { notes.push(`${acc.currency} kursini ololmadim — "${it.note}" yozilmadi.`); continue; }
      note = `${note || ""} (${amount} ${cur})`.trim();
      amt = round2((amount * rates[cur]) / rates[acc.currency]);
      cur = acc.currency;
    }
    const base = { date: validDate(it.date), amount: amt, currency: cur, rate: rates[cur], account_id: acc ? acc.id : null, project_id: projectId(it.project) };
    if (it.type === "income") incomes.push({ ...base, source: note });
    else expenses.push({ ...base, category_id: categoryId(it.category), payment_type: pt || (acc ? (acc.kind === "naqd" ? "naqd" : acc.kind === "karta" ? "karta" : "otkazma") : null), note });
  }
 
  const saved = [];
  const post = (table, rows, select) => sb(`${table}?select=${select}`, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(rows) });
  const [e, i, t] = await Promise.all([
    expenses.length ? post("expenses", expenses, "id,date,amount,currency,rate,account_id,note,payment_type,categories(name),projects(name)") : [],
    incomes.length ? post("incomes", incomes, "id,date,amount,currency,rate,account_id,source,projects(name)") : [],
    transfers.length ? post("transfers", transfers, "id,date,from_account,to_account,amount,to_amount,note") : [],
  ]);
  saved.push(...e.map((r) => formatRow(r, "expense", accounts)), ...i.map((r) => formatRow(r, "income", accounts)), ...t.map((r) => formatTransfer(r, accounts)));
  // Budjet: shu oyda limitga yaqinlashgan / oshgan kategoriyalar (faqat hozir yozilgan xarajat kategoriyalari)
  let alerts = [];
  try {
    const touched = [...new Set(expenses.map((x) => x.category_id).filter(Boolean))];
    const limited = touched.length ? await sb(`categories?select=id,name,monthly_limit&id=in.(${touched.join(",")})&monthly_limit=gt.0`) : [];
    if (limited.length) {
      const [mf, mt] = monthRange(today.slice(0, 7));
      const rows = await sb(`expenses?select=amount,rate,category_id&category_id=in.(${limited.map((c) => c.id).join(",")})&date=gte.${mf}&date=lt.${mt}`);
      alerts = budgetAlerts(limited.map((c) => ({ name: c.name, limit: num(c.monthly_limit), spent: Math.round(rows.filter((x) => x.category_id === c.id).reduce((s2, x) => s2 + uzsOf(x), 0)) })));
    }
  } catch {}
  // G'alati xarajat: odatdagidan ancha katta summa
  let unusualList = [];
  try {
    if (e.length) {
      const hist = (await loadHistory(addDays(today, -120))).ex;
      unusualList = e.map((row) => unusual({ id: row.id, date: row.date, uzs: Math.round(uzsOf(row)), cat: row.categories?.name || "Boshqa", note: row.note || "" }, hist)).filter(Boolean);
    }
  } catch {}
  return { saved, transcript, alerts, unusual: unusualList, question: notes.length ? notes.join(" ") : saved.length ? null : "Summani aniqlay olmadim." };
}
 
// Hisoblar qoldig'i: boshlang'ich + daromad − xarajat − chiqqan o'tkazma + kelgan o'tkazma
async function accountBalances(accounts) {
  const [ex, inc, tr] = await Promise.all([
    sb("expenses?select=account_id,amount&account_id=not.is.null"),
    sb("incomes?select=account_id,amount&account_id=not.is.null"),
    sb("transfers?select=from_account,to_account,amount,to_amount"),
  ]);
  const bal = {};
  for (const a of accounts) bal[a.id] = num(a.opening_balance);
  for (const r of inc) if (r.account_id in bal) bal[r.account_id] += num(r.amount);
  for (const r of ex) if (r.account_id in bal) bal[r.account_id] -= num(r.amount);
  for (const r of tr) {
    if (r.from_account in bal) bal[r.from_account] -= num(r.amount);
    if (r.to_account in bal) bal[r.to_account] += num(r.to_amount);
  }
  return bal;
}
 
// Oy chegaralari: "2026-10" → ["2026-10-01", "2026-11-01"]
function monthRange(ym) {
  const [y, m] = ym.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return [`${ym}-01`, `${next}-01`];
}
function addMonths(ym, k) {
  let [y, m] = ym.split("-").map(Number);
  m += k; while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; }
  return `${y}-${String(m).padStart(2, "0")}`;
}
const uzsOf = (r) => num(r.amount) * (num(r.rate) || 1);
 
// Budjet ogohlantirishlari: limitning 80% va 100% dan oshgan kategoriyalar
function budgetAlerts(byCategory) {
  return byCategory.filter((c) => c.limit > 0 && c.spent >= c.limit * 0.8).map((c) => ({
    name: c.name, spent: c.spent, limit: c.limit, pct: Math.round((c.spent / c.limit) * 100), over: c.spent > c.limit,
  }));
}
 
async function summary(monthParam) {
  const today = tashkentToday();
  const curMonth = today.slice(0, 7);
  const month = /^\d{4}-\d{2}$/.test(monthParam || "") && monthParam <= curMonth ? monthParam : curMonth;
  const [from, to] = monthRange(month);
  const histFrom = monthRange(addMonths(month, -5))[0];
  const range = `date=gte.${from}&date=lt.${to}`;
 
  const [expenses, incomes, transfers, categories, projects, accounts, rates, histE, histI] = await Promise.all([
    sb(`expenses?select=id,date,amount,currency,rate,account_id,note,payment_type,categories(name),projects(name)&${range}&order=date.desc,id.desc`),
    sb(`incomes?select=id,date,amount,currency,rate,account_id,source,projects(name)&${range}&order=date.desc,id.desc`),
    sb(`transfers?select=id,date,from_account,to_account,amount,to_amount,note&${range}&order=date.desc,id.desc`),
    sb("categories?select=id,name,monthly_limit&order=name"),
    sb("projects?select=id,name,status&order=id"),
    sb("accounts?select=id,name,currency,kind,opening_balance,archived&order=id"),
    getRates(today).catch(() => ({ UZS: 1 })),
    sb(`expenses?select=date,amount,rate&date=gte.${histFrom}&date=lt.${to}`),
    sb(`incomes?select=date,amount,rate&date=gte.${histFrom}&date=lt.${to}`),
  ]);
  checkCategories(categories);
 
  // Kategoriyalar va limitlar
  const spentBy = {};
  for (const e of expenses) {
    const name = e.categories?.name || "Boshqa";
    spentBy[name] = (spentBy[name] || 0) + uzsOf(e);
  }
  const byCategory = categories
    .map((c) => ({ id: c.id, name: c.name, spent: Math.round(spentBy[c.name] || 0), limit: num(c.monthly_limit) }))
    .sort((a, b) => b.spent - a.spent || a.name.localeCompare(b.name));
 
  // Kunlik xarajat (grafik uchun)
  const days = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
  const daily = Array.from({ length: days }, (_, i) => ({ day: i + 1, expense: 0, income: 0 }));
  for (const e of expenses) daily[Number(e.date.slice(8, 10)) - 1].expense += uzsOf(e);
  for (const e of incomes) daily[Number(e.date.slice(8, 10)) - 1].income += uzsOf(e);
  daily.forEach((d) => { d.expense = Math.round(d.expense); d.income = Math.round(d.income); });
 
  // Oxirgi 6 oy: daromad va xarajat
  const months = Array.from({ length: 6 }, (_, i) => ({ month: addMonths(month, i - 5), income: 0, expense: 0 }));
  const mIdx = (d) => months.findIndex((m) => m.month === d.slice(0, 7));
  for (const e of histE) { const i = mIdx(e.date); if (i >= 0) months[i].expense += uzsOf(e); }
  for (const e of histI) { const i = mIdx(e.date); if (i >= 0) months[i].income += uzsOf(e); }
  months.forEach((m) => { m.income = Math.round(m.income); m.expense = Math.round(m.expense); });
 
  // Loyihalar foydasi (shu oy)
  const proj = {};
  for (const p of projects) proj[p.name] = { name: p.name, status: p.status, income: 0, expense: 0 };
  for (const e of expenses) if (e.projects?.name && proj[e.projects.name]) proj[e.projects.name].expense += uzsOf(e);
  for (const e of incomes) if (e.projects?.name && proj[e.projects.name]) proj[e.projects.name].income += uzsOf(e);
  const byProject = Object.values(proj).map((p) => ({ ...p, income: Math.round(p.income), expense: Math.round(p.expense), profit: Math.round(p.income - p.expense) }));
 
  const bal = await accountBalances(accounts);
  const accList = accounts.filter((a) => !a.archived).map((a) => ({
    id: a.id, name: a.name, currency: a.currency, kind: a.kind, opening_balance: num(a.opening_balance),
    balance: round2(bal[a.id]), uzs: rates[a.currency] ? Math.round(bal[a.id] * rates[a.currency]) : null,
  }));
 
  const recent = [
    ...expenses.map((r) => formatRow(r, "expense", accounts)),
    ...incomes.map((r) => formatRow(r, "income", accounts)),
    ...transfers.map((r) => formatTransfer(r, accounts)),
  ]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id))
    .slice(0, 60);
 
  return {
    month,
    isCurrent: month === curMonth,
    today,
    totalExpense: Math.round(expenses.reduce((s, e) => s + uzsOf(e), 0)),
    totalIncome: Math.round(incomes.reduce((s, e) => s + uzsOf(e), 0)),
    byCategory,
    alerts: budgetAlerts(byCategory),
    daily,
    months,
    byProject,
    accounts: accList,
    netWorth: accList.reduce((s, a) => s + (a.uzs || 0), 0),
    rates: { USD: rates.USD || null, EUR: rates.EUR || null, RUB: rates.RUB || null },
    recent,
  };
}
 
// ---------- 4-bosqich: AI maslahatchi, haftalik xulosa, g'alati xarajat ----------
 
function addDays(d, k) {
  const t = new Date(d + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + k);
  return t.toISOString().slice(0, 10);
}
const median = (arr) => { if (!arr.length) return 0; const a = [...arr].sort((x, y) => x - y), m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
 
// G'alati xarajat: shu kategoriyadagi odatiy (median) summadan 3 baravar katta va kamida 200 ming so'm
function unusual(exp, history) {
  const prior = history.filter((h) => h.cat === exp.cat && h.id !== exp.id).map((h) => h.uzs);
  if (prior.length < 4) return null;
  const med = median(prior);
  if (exp.uzs >= Math.max(med * 3, 200000)) return { ...exp, median: Math.round(med), times: Math.round((exp.uzs / med) * 10) / 10 };
  return null;
}
 
async function loadHistory(fromDate) {
  const [ex, inc] = await Promise.all([
    sb(`expenses?select=id,date,amount,rate,note,categories(name),projects(name)&date=gte.${fromDate}&order=date.desc,id.desc`),
    sb(`incomes?select=id,date,amount,rate,source,projects(name)&date=gte.${fromDate}&order=date.desc,id.desc`),
  ]);
  return {
    ex: ex.map((e) => ({ id: e.id, date: e.date, uzs: Math.round(uzsOf(e)), cat: e.categories?.name || "Boshqa", project: e.projects?.name || null, note: e.note || "" })),
    inc: inc.map((e) => ({ id: e.id, date: e.date, uzs: Math.round(uzsOf(e)), project: e.projects?.name || null, note: e.source || "" })),
  };
}
 
// Haftalik xulosa (AI'siz, tez): oxirgi 7 kun va undan oldingi 7 kun
async function insights() {
  const today = tashkentToday();
  const { ex, inc } = await loadHistory(addDays(today, -120));
  const w1 = addDays(today, -6), w0 = addDays(today, -13);
  const thisW = ex.filter((e) => e.date >= w1), prevW = ex.filter((e) => e.date >= w0 && e.date < w1);
  const sum = (a) => a.reduce((s2, x) => s2 + x.uzs, 0);
  const byCat = (a) => a.reduce((m, x) => ((m[x.cat] = (m[x.cat] || 0) + x.uzs), m), {});
  const c1 = byCat(thisW), c0 = byCat(prevW);
  const cats = [...new Set([...Object.keys(c1), ...Object.keys(c0)])]
    .map((name) => ({ name, now: c1[name] || 0, before: c0[name] || 0, diff: (c1[name] || 0) - (c0[name] || 0) }))
    .sort((a, b) => b.now - a.now);
  const anomalies = ex.filter((e) => e.date >= addDays(today, -30)).map((e) => unusual(e, ex)).filter(Boolean).slice(0, 5);
  return {
    from: w1, to: today,
    expense: sum(thisW), expensePrev: sum(prevW),
    income: sum(inc.filter((e) => e.date >= w1)),
    topCats: cats.slice(0, 5),
    biggest: [...thisW].sort((a, b) => b.uzs - a.uzs).slice(0, 3),
    anomalies,
    count: thisW.length,
  };
}
 
// AI maslahatchi: savolga egasining haqiqiy ma'lumotlari asosida javob
async function ask(question) {
  const q = String(question || "").trim().slice(0, 500);
  if (!q) throw new Error("Savol yozing");
  const today = tashkentToday();
  const from = monthRange(addMonths(today.slice(0, 7), -2))[0];
  const [{ ex, inc }, categories, accounts, rates] = await Promise.all([
    loadHistory(from),
    sb("categories?select=name,monthly_limit&order=name"),
    sb("accounts?select=id,name,currency,kind,opening_balance,archived&order=id"),
    getRates(today).catch(() => ({ UZS: 1 })),
  ]);
  const bal = await accountBalances(accounts);
  const monthsData = {};
  for (const e of ex) { const m = (monthsData[e.date.slice(0, 7)] ||= { xarajat: 0, daromad: 0, kategoriyalar: {}, loyihalar: {} }); m.xarajat += e.uzs; m.kategoriyalar[e.cat] = (m.kategoriyalar[e.cat] || 0) + e.uzs; if (e.project) { const pr = (m.loyihalar[e.project] ||= { daromad: 0, xarajat: 0 }); pr.xarajat += e.uzs; } }
  for (const e of inc) { const m = (monthsData[e.date.slice(0, 7)] ||= { xarajat: 0, daromad: 0, kategoriyalar: {}, loyihalar: {} }); m.daromad += e.uzs; if (e.project) { const pr = (m.loyihalar[e.project] ||= { daromad: 0, xarajat: 0 }); pr.daromad += e.uzs; } }
  const data = {
    bugun: today,
    oylar: monthsData,
    limitlar: Object.fromEntries(categories.filter((c) => num(c.monthly_limit) > 0).map((c) => [c.name, num(c.monthly_limit)])),
    hisoblar: accounts.filter((a) => !a.archived).map((a) => ({ nom: a.name, valyuta: a.currency, qoldiq: round2(bal[a.id]) })),
    dollar_kursi: rates.USD || null,
    shu_oy_yozuvlari: ex.filter((e) => e.date.slice(0, 7) === today.slice(0, 7)).slice(0, 80).map((e) => [e.date.slice(5), e.uzs, e.cat, e.note.slice(0, 40), e.project || ""]),
    shu_oy_daromadlari: inc.filter((e) => e.date.slice(0, 7) === today.slice(0, 7)).slice(0, 30).map((e) => [e.date.slice(5), e.uzs, e.note.slice(0, 40), e.project || ""]),
  };
  const prompt = `Sen — egasining shaxsiy va biznes moliya bo'yicha yordamchisisan. Egasi tadbirkor (AI agentlar va Jarvis mahsulotini sotadi).
Faqat quyidagi HAQIQIY ma'lumotlar asosida o'zbek tilida (lotin), "siz"lab, qisqa javob ber: 3–8 gap yoki qisqa ro'yxat. Raqamlarni so'mda, bo'shliq bilan yoz (1 250 000).
Ma'lumotda yo'q narsani to'qima; yetarli bo'lmasa — shuni ochiq ayt va nimani yozib borish kerakligini ayt. Taqqoslash so'ralsa — oylarni solishtir. Kerak bo'lsa 1–3 ta aniq, amaliy maslahat ber (qayerda tejash, qaysi limitni qo'yish).
Investitsiya, kredit, soliq bo'yicha qat'iy tavsiya berma — faqat raqamlarni tushuntir va mutaxassisga murojaat qilishni eslat.
Markdown ishlatma (yulduzcha, #), oddiy matn; ro'yxat kerak bo'lsa "• " bilan.
"shu_oy_yozuvlari" formati: [oy-kun, summa_so'm, kategoriya, izoh, loyiha].
 
MA'LUMOTLAR (JSON): ${JSON.stringify(data)}
 
SAVOL: ${q}`;
  const text = await callGemini({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 900 } }, true);
  return { answer: text.replace(/\*\*/g, "").replace(/^#+\s*/gm, "").trim() || "Javob tayyorlay olmadim, qayta urinib ko'ring." };
}
 
// Kategoriya limiti (0 — limitsiz)
async function setLimit(b) {
  const id = parseInt(b.id, 10);
  if (!Number.isInteger(id)) throw new Error("Noto'g'ri ID");
  const v = Number(String(b.limit ?? "").replace(/\s/g, "").replace(",", ".")) || 0;
  if (v < 0) throw new Error("Limit manfiy bo'lmaydi");
  await sb(`categories?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ monthly_limit: Math.round(v) }) });
  return { ok: true };
}
 
// Yangi kategoriya yoki loyiha
async function addName(table, name) {
  const n = String(name || "").trim().slice(0, 40);
  if (!n) throw new Error("Nomini yozing");
  try { await sb(table, { method: "POST", body: JSON.stringify([{ name: n }]) }); }
  catch (e) { if (/duplicate|unique/i.test(e.message)) throw new Error("Bunday nom bor"); throw e; }
  return { ok: true };
}
 
async function removeRow(kind, id) {
  const table = kind === "income" ? "incomes" : kind === "transfer" ? "transfers" : "expenses";
  const rowId = parseInt(id, 10);
  if (!Number.isInteger(rowId)) throw new Error("Noto'g'ri ID");
  await sb(`${table}?id=eq.${rowId}`, { method: "DELETE" });
  return { ok: true };
}
 
// Hisob qo'shish / o'zgartirish / arxivlash
async function saveAccount(b) {
  const row = {};
  if (b.name !== undefined) {
    row.name = String(b.name || "").trim().slice(0, 40);
    if (!row.name) throw new Error("Hisob nomini yozing");
  }
  if (b.currency !== undefined) {
    if (!CURRENCIES.includes(b.currency)) throw new Error("Valyuta: UZS, USD, EUR yoki RUB");
    row.currency = b.currency;
  }
  if (b.kind !== undefined) {
    if (!ACCOUNT_KINDS.includes(b.kind)) throw new Error("Turi: naqd, karta yoki bank");
    row.kind = b.kind;
  }
  if (b.opening_balance !== undefined) {
    const v = Number(String(b.opening_balance).replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(v)) throw new Error("Boshlang'ich qoldiq — raqam bo'lishi kerak");
    row.opening_balance = round2(v);
  }
  if (b.archived !== undefined) row.archived = !!b.archived;
  try {
    if (b.id) {
      const id = parseInt(b.id, 10);
      if (!Number.isInteger(id)) throw new Error("Noto'g'ri ID");
      await sb(`accounts?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(row) });
    } else {
      if (!row.name) throw new Error("Hisob nomini yozing");
      await sb("accounts", { method: "POST", body: JSON.stringify([{ currency: "UZS", kind: "naqd", opening_balance: 0, ...row }]) });
    }
  } catch (e) {
    if (/duplicate|unique/i.test(e.message)) throw new Error("Bunday nomli hisob bor — boshqa nom tanlang");
    throw e;
  }
  return { ok: true };
}
 
// "Hozir menda X bor" — boshlang'ich qoldiqni shunday tanlaydiki, joriy qoldiq aynan X bo'ladi
async function setBalance(b) {
  const id = parseInt(b.id, 10);
  if (!Number.isInteger(id)) throw new Error("Noto'g'ri ID");
  const target = Number(String(b.balance).replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(target)) throw new Error("Qoldiq — raqam bo'lishi kerak");
  const accounts = await sb("accounts?select=id,name,currency,kind,opening_balance,archived&order=id");
  const acc = accounts.find((a) => a.id === id);
  if (!acc) throw new Error("Hisob topilmadi");
  const bal = await accountBalances(accounts);
  const opening = round2(num(acc.opening_balance) + (target - bal[id]));
  await sb(`accounts?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ opening_balance: opening }) });
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
 
  // Parol: telefon klaviaturasi o'zgartirib yuboradigan belgilar (probel, ’ “ —) bir xil hisoblanadi
  const norm = (v) => String(v ?? "").normalize("NFKC").trim().replace(/[‘’ʻʼ`´]/g, "'").replace(/[“”«»]/g, '"').replace(/[—–]/g, "--");
  const expected = norm(process.env.APP_PASSWORD);
  const given = norm(body.password);
  if (!expected) {
    return json({ error: "Serverda APP_PASSWORD topilmadi — Netlify → Environment variables'da nomi aynan APP_PASSWORD ekanini va 'Functions' doirasi belgilanganini tekshiring, keyin Deploys → Trigger deploy." }, 401);
  }
  if (given !== expected) {
    const hint = given.toLowerCase() === expected.toLowerCase()
      ? " — harflar to'g'ri, lekin KATTA/kichik harf farq qiladi (telefon birinchi harfni katta qilib qo'ygan bo'lishi mumkin)."
      : given.length !== expected.length ? ` — kiritilgani ${given.length} ta belgi, kutilgani boshqa uzunlikda.` : "";
    return json({ error: "Parol noto'g'ri" + hint }, 401);
  }
 
  try {
    switch (body.action) {
      case "login":
        return json({ ok: true });
      case "add":
        return json(await addFromText(body.text, checkMedia(body)));
      case "summary":
        return json(await summary(body.month));
      case "ask":
        return json(await ask(body.question));
      case "insights":
        return json(await insights());
      case "set_limit":
        return json(await setLimit(body));
      case "category_add":
        return json(await addName("categories", body.name));
      case "project_add":
        return json(await addName("projects", body.name));
      case "delete":
        return json(await removeRow(body.kind, body.id));
      case "account_save":
        return json(await saveAccount(body));
      case "account_balance":
        return json(await setBalance(body));
      default:
        return json({ error: "Noma'lum amal" }, 400);
    }
  } catch (err) {
    return json({ error: err.message }, 500);
  }
};
 
export const config = { path: "/api" };
 
