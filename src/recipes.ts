import { withAuth } from "./session";
import { isMember } from "./lists";
import { json, readJson } from "./util";
import type { Env, Recipe, RecipeIngredient } from "./types";

const GEMINI_MODEL = "gemini-3.5-flash-lite";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Obergrenzen gegen missbräuchlich große Bodies bzw. entgleiste LLM-Antworten
const MAX_ZUTATEN = 50;
const MAX_SCHRITTE = 30;
const GEMINI_TIMEOUT_MS = 45_000;

/** 404 statt 403, damit die Existenz fremder Listen nicht aufscheint. */
function notFound(): Response {
  return json({ error: "Liste nicht gefunden." }, 404);
}

async function checkListAccess(env: Env, listId: string, userId: string): Promise<boolean> {
  const member = await isMember(env.DB, listId, userId);
  if (!member) return false;
  const meta = await env.DB.prepare("SELECT 1 AS x FROM lists WHERE id = ?").bind(listId).first();
  return meta !== null;
}

// ---------- Gemini ----------

const SYSTEM_ANWEISUNG = `Du bist ein Kochassistent für eine Einkaufslisten-App. Erstelle zu einem Gericht ein Rezept mit passender Einkaufsliste.
Regeln:
- Antworte auf Deutsch.
- Skaliere alle Zutatenmengen exakt auf die gewünschte Portionenzahl.
- Gib praktische Einkaufsmengen mit handelsüblichen Einheiten an (z. B. "500 g", "2 EL", "1 Bund", "2 Dosen").
- "zeit" ist die ungefähre Zubereitungszeit (z. B. "ca. 30 Minuten").
- Die Schritte sind kurze, klare Anweisungen ohne Nummerierung im Text.`;

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

async function generateRecipe(env: Env, gericht: string, portionen: number): Promise<Recipe> {
  if (!env.GEMINI_API_KEY) {
    throw new GeminiError(500, "Der Server hat keinen Gemini-API-Key konfiguriert.");
  }

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_ANWEISUNG }] },
    contents: [{ role: "user", parts: [{ text: `Gericht: "${gericht}"\nPortionen: ${portionen}` }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          titel: { type: "STRING" },
          zeit: { type: "STRING" },
          zutaten: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: { name: { type: "STRING" }, menge: { type: "STRING" } },
              required: ["name"],
            },
          },
          schritte: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["titel", "zutaten", "schritte"],
      },
    },
  };

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), GEMINI_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      throw new GeminiError(504, "Die Rezept-Erstellung hat zu lange gedauert. Bitte versuch es nochmal.");
    }
    throw new GeminiError(502, "Der KI-Dienst ist gerade nicht erreichbar. Bitte versuch es gleich nochmal.");
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    console.error("Gemini-Fehler:", res.status, await res.text().catch(() => ""));
    throw new GeminiError(502, "Die Rezept-Erstellung ist fehlgeschlagen. Bitte versuch es nochmal.");
  }

  let data: GeminiResponse;
  try {
    data = (await res.json()) as GeminiResponse;
  } catch {
    throw new GeminiError(502, "Die Antwort des KI-Dienstes konnte nicht verarbeitet werden.");
  }

  if (data.promptFeedback?.blockReason) {
    throw new GeminiError(400, "Dieses Gericht kann ich leider nicht in ein Rezept umsetzen.");
  }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new GeminiError(502, "Die Antwort des KI-Dienstes konnte nicht verarbeitet werden.");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new GeminiError(502, "Die Antwort des KI-Dienstes konnte nicht verarbeitet werden.");
  }

  const recipe = sanitizeRecipe(raw, portionen);
  if (!recipe) {
    throw new GeminiError(502, "Die Antwort des KI-Dienstes konnte nicht verarbeitet werden.");
  }
  return recipe;
}

/** Fehler mit HTTP-Status und deutscher Nutzermeldung. */
export class GeminiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

/**
 * Prüft ein (vom LLM oder Client geliefertes) Rezept strikt und kürzt es auf
 * erlaubte Längen; null, wenn titel/zutaten/schritte nicht verwertbar sind.
 */
function sanitizeRecipe(raw: unknown, defaultPortionen: number): Recipe | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const titel = typeof obj.titel === "string" ? obj.titel.trim().slice(0, 120) : "";
  if (!titel) return null;

  const zeit = typeof obj.zeit === "string" && obj.zeit.trim() ? obj.zeit.trim().slice(0, 40) : undefined;

  const portionenRaw = typeof obj.portionen === "number" ? Math.round(obj.portionen) : defaultPortionen;
  const portionen = Math.min(12, Math.max(1, portionenRaw || defaultPortionen));

  if (!Array.isArray(obj.zutaten) || !Array.isArray(obj.schritte)) return null;

  const zutaten: RecipeIngredient[] = [];
  for (const entry of obj.zutaten.slice(0, MAX_ZUTATEN)) {
    if (typeof entry !== "object" || entry === null) continue;
    const name = typeof (entry as Record<string, unknown>).name === "string"
      ? ((entry as Record<string, unknown>).name as string).trim().slice(0, 120)
      : "";
    if (!name) continue;
    const mengeRaw = (entry as Record<string, unknown>).menge;
    const menge = typeof mengeRaw === "string" && mengeRaw.trim() ? mengeRaw.trim().slice(0, 40) : undefined;
    zutaten.push(menge ? { name, menge } : { name });
  }
  if (!zutaten.length) return null;

  const schritte = obj.schritte
    .filter((s): s is string => typeof s === "string" && !!s.trim())
    .slice(0, MAX_SCHRITTE)
    .map((s) => s.trim().slice(0, 500));
  if (!schritte.length) return null;

  return { titel, zeit, portionen, zutaten, schritte };
}

// ---------- HTTP-Handler ----------

interface GenerateBody {
  gericht?: unknown;
  portionen?: unknown;
}

/** POST /api/list/:id/generate – ruft Gemini auf und liefert ein Rezept zur Vorschau (kein Speichern). */
export async function handleGenerate(request: Request, env: Env, listId: string): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    if (!(await checkListAccess(env, listId, user.id))) return notFound();

    const body = await readJson<GenerateBody>(request);
    const gericht = typeof body?.gericht === "string" ? body.gericht.trim().slice(0, 120) : "";
    if (!gericht) return json({ error: "Bitte gib ein Gericht an." }, 400);

    const portionenRaw = typeof body?.portionen === "number" ? Math.round(body.portionen) : 2;
    const portionen = Math.min(12, Math.max(1, portionenRaw || 2));

    try {
      const rezept = await generateRecipe(env, gericht, portionen);
      return json({ rezept });
    } catch (err) {
      if (err instanceof GeminiError) return json({ error: err.message }, err.status);
      throw err;
    }
  });
}

/**
 * Prüft eine Liste von Zutaten/Artikeln und kürzt sie auf erlaubte Längen.
 * Wird für gespeicherte Rezepte und direkte Batch-Additions genutzt.
 */
function sanitizeItems(raw: unknown): RecipeIngredient[] {
  if (!Array.isArray(raw)) return [];
  const out: RecipeIngredient[] = [];
  for (const entry of raw.slice(0, MAX_ZUTATEN)) {
    if (typeof entry !== "object" || entry === null) continue;
    const nameRaw = (entry as Record<string, unknown>).name;
    const name = typeof nameRaw === "string" ? nameRaw.trim().slice(0, 120) : "";
    if (!name) continue;
    const mengeRaw = (entry as Record<string, unknown>).menge;
    const menge = typeof mengeRaw === "string" && mengeRaw.trim() ? mengeRaw.trim().slice(0, 40) : undefined;
    out.push(menge ? { name, menge } : { name });
  }
  return out;
}

interface ItemsBody {
  items?: unknown;
}

/** POST /api/list/:id/items – legt mehrere Artikel auf die Liste (ohne Rezept zu speichern). */
export async function handleAddItems(request: Request, env: Env, listId: string): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    if (!(await checkListAccess(env, listId, user.id))) return notFound();

    const body = await readJson<ItemsBody>(request);
    const items = sanitizeItems(body?.items);
    if (!items.length) return json({ error: "Keine gültigen Artikel." }, 400);

    const stub = env.SHOPPING_LIST_DO.get(env.SHOPPING_LIST_DO.idFromName(listId));
    const doRes = await stub.fetch("https://do/add-items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ listId, displayName: user.displayName, items }),
    });
    if (!doRes.ok) return json({ error: "Die Artikel konnten nicht hinzugefügt werden." }, 502);

    const data = (await doRes.json()) as { added?: number };
    return json({ added: data.added ?? 0 });
  });
}

interface RecipeRow {
  id: string;
  titel: string;
  zeit: string | null;
  portionen: number;
  zutaten: string;
  schritte: string;
  created_by: string;
  created_at: number;
}

function rowToRecipe(row: RecipeRow): Recipe {
  return {
    id: row.id,
    titel: row.titel,
    zeit: row.zeit ?? undefined,
    portionen: row.portionen,
    zutaten: safeParse(row.zutaten, []),
    schritte: safeParse(row.schritte, []),
    createdAt: row.created_at,
  };
}

function safeParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

interface SaveBody {
  titel?: unknown;
  zeit?: unknown;
  portionen?: unknown;
  zutaten?: unknown;
  schritte?: unknown;
}

/**
 * POST /api/list/:id/recipes – speichert ein Rezept dauerhaft und legt die
 * Zutaten auf die Einkaufsliste (ein Broadcast für alle verbundenen Clients).
 */
export async function handleSaveRecipe(request: Request, env: Env, listId: string): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    if (!(await checkListAccess(env, listId, user.id))) return notFound();

    const body = await readJson<SaveBody>(request);
    const recipe = sanitizeRecipe(body, 2);
    if (!recipe) return json({ error: "Das Rezept ist unvollständig." }, 400);

    const id = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO recipes (id, list_id, titel, zeit, portionen, zutaten, schritte, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(id, listId, recipe.titel, recipe.zeit ?? null, recipe.portionen, JSON.stringify(recipe.zutaten), JSON.stringify(recipe.schritte), user.id, now)
      .run();

    let added = 0;
    try {
      const stub = env.SHOPPING_LIST_DO.get(env.SHOPPING_LIST_DO.idFromName(listId));
      const doRes = await stub.fetch("https://do/add-items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ listId, displayName: user.displayName, items: recipe.zutaten }),
      });
      if (doRes.ok) {
        const data = (await doRes.json()) as { added?: number };
        added = data.added ?? 0;
      }
    } catch (err) {
      console.error("Add-Items fehlgeschlagen:", err);
    }

    return json({ rezept: { ...recipe, id, createdAt: now }, added }, 201);
  });
}

/** GET /api/list/:id/recipes – alle gespeicherten Rezepte der Liste. */
export async function handleGetRecipes(request: Request, env: Env, listId: string): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    if (!(await checkListAccess(env, listId, user.id))) return notFound();

    const { results } = await env.DB.prepare(
      `SELECT id, titel, zeit, portionen, zutaten, schritte, created_by, created_at
       FROM recipes WHERE list_id = ? ORDER BY created_at DESC`
    )
      .bind(listId)
      .all<RecipeRow>();

    return json({ rezepte: results.map(rowToRecipe) });
  });
}

/** DELETE /api/list/:id/recipes/:recipeId – löscht ein Rezept dieser Liste. */
export async function handleDeleteRecipe(request: Request, env: Env, listId: string, recipeId: string): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    if (!(await checkListAccess(env, listId, user.id))) return notFound();

    const result = await env.DB.prepare("DELETE FROM recipes WHERE id = ? AND list_id = ?")
      .bind(recipeId, listId)
      .run();
    if (!result.meta.changes) return json({ error: "Rezept nicht gefunden." }, 404);

    return json({ ok: true });
  });
}
