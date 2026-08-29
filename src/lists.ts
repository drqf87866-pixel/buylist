import { randomToken } from "./crypto";
import { withAuth } from "./session";
import { json, readJson } from "./util";
import type { Env, PublicUser } from "./types";

interface ListRow {
  id: string;
  name: string;
  owner_id: string;
  invite_token: string;
  created_at: number;
}

export async function isMember(db: D1Database, listId: string, userId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS x FROM list_memberships WHERE list_id = ? AND user_id = ?")
    .bind(listId, userId)
    .first();
  return row !== null;
}

async function getListMeta(db: D1Database, listId: string): Promise<ListRow | null> {
  return db
    .prepare("SELECT id, name, owner_id, invite_token, created_at FROM lists WHERE id = ?")
    .bind(listId)
    .first<ListRow>();
}

/** 404 statt 403, damit die Existenz fremder Listen nicht aufscheint. */
function notFound(): Response {
  return json({ error: "Liste nicht gefunden." }, 404);
}

export async function handleGetLists(request: Request, env: Env): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    const { results } = await env.DB.prepare(
      `SELECT l.id, l.name, l.owner_id AS ownerId, u.display_name AS ownerName,
              l.created_at AS createdAt,
              (SELECT COUNT(*) FROM list_memberships m2 WHERE m2.list_id = l.id) AS memberCount
       FROM lists l
       JOIN list_memberships m ON m.list_id = l.id AND m.user_id = ?
       JOIN users u ON u.id = l.owner_id
       ORDER BY l.created_at DESC`
    )
      .bind(user.id)
      .all();
    return json({ lists: results });
  });
}

export async function handleCreateList(request: Request, env: Env): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    const body = await readJson<{ name?: string }>(request);
    const name = (body?.name ?? "").trim().slice(0, 80);
    if (!name) return json({ error: "Bitte gib der Liste einen Namen." }, 400);

    const id = crypto.randomUUID();
    const inviteToken = randomToken(16);
    const now = Date.now();

    await env.DB.batch([
      env.DB.prepare("INSERT INTO lists (id, name, owner_id, invite_token, created_at) VALUES (?, ?, ?, ?, ?)").bind(
        id,
        name,
        user.id,
        inviteToken,
        now
      ),
      env.DB.prepare("INSERT INTO list_memberships (list_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)").bind(
        id,
        user.id,
        now
      ),
    ]);

    // Zugehöriges Durable Object initialisieren (State bleibt dort persistent)
    const stub = env.SHOPPING_LIST_DO.get(env.SHOPPING_LIST_DO.idFromName(id));
    await stub.fetch("https://do/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ listId: id, name }),
    });

    return json({ list: { id, name, ownerId: user.id, createdAt: now } }, 201);
  });
}

export async function handleSnapshot(request: Request, env: Env, listId: string): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    const meta = await getListMeta(env.DB, listId);
    if (!meta || !(await isMember(env.DB, listId, user.id))) return notFound();

    const stub = env.SHOPPING_LIST_DO.get(env.SHOPPING_LIST_DO.idFromName(listId));
    return stub.fetch(`https://do/snapshot?id=${encodeURIComponent(listId)}&name=${encodeURIComponent(meta.name)}`);
  });
}

export async function handleInvite(request: Request, env: Env, listId: string): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    const meta = await getListMeta(env.DB, listId);
    if (!meta || !(await isMember(env.DB, listId, user.id))) return notFound();

    const origin = new URL(request.url).origin;
    return json({ url: `${origin}/join/${meta.invite_token}` });
  });
}

export async function handleJoin(request: Request, env: Env): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }: { user: PublicUser }) => {
    const body = await readJson<{ token?: string }>(request);
    const token = (body?.token ?? "").trim();
    if (!token) return json({ error: "Dieser Einladungslink ist ungültig." }, 400);

    const list = await env.DB
      .prepare("SELECT id, name FROM lists WHERE invite_token = ?")
      .bind(token)
      .first<{ id: string; name: string }>();
    if (!list) return json({ error: "Dieser Einladungslink ist ungültig." }, 404);

    await env.DB
      .prepare("INSERT OR IGNORE INTO list_memberships (list_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)")
      .bind(list.id, user.id, Date.now())
      .run();

    return json({ list });
  });
}
