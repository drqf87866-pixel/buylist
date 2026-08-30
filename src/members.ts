import { withAuth } from "./session";
import { getListMeta, getRole, isMember } from "./lists";
import { json, readJson } from "./util";
import type { Env } from "./types";

/** 404 statt 403, damit die Existenz fremder Listen nicht aufscheint. */
function notFound(): Response {
  return json({ error: "Liste nicht gefunden." }, 404);
}

interface MemberRow {
  id: string;
  email: string;
  display_name: string;
  role: string;
  joined_at: number;
}

/** GET /api/list/:id/members – alle Mitglieder einer Liste (jedes Mitglied). */
export async function handleGetMembers(request: Request, env: Env, listId: string): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    if (!(await isMember(env.DB, listId, user.id))) return notFound();
    const meta = await getListMeta(env.DB, listId);

    const { results } = await env.DB.prepare(
      `SELECT u.id, u.email, u.display_name, m.role, m.joined_at
       FROM list_memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.list_id = ?
       ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, m.joined_at ASC`
    )
      .bind(listId)
      .all<MemberRow>();

    return json({
      ownerId: meta?.owner_id ?? null,
      members: (results ?? []).map((r) => ({
        id: r.id,
        email: r.email,
        displayName: r.display_name,
        role: r.role,
        joinedAt: r.joined_at,
      })),
    });
  });
}

interface RemoveBody {
  userId?: unknown;
}

/**
 * DELETE /api/list/:id/members – entfernt ein Mitglied. Nur der Owner darf das,
 * weder sich selbst noch einen anderen Owner entfernen; der letzte Owner bleibt.
 */
export async function handleRemoveMember(request: Request, env: Env, listId: string): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    if (!(await isMember(env.DB, listId, user.id))) return notFound();
    const meta = await getListMeta(env.DB, listId);
    const role = await getRole(env.DB, listId, user.id);
    if (role !== "owner" && meta?.owner_id !== user.id) {
      return json({ error: "Nur der Owner kann Mitglieder entfernen.", role: role ?? null }, 403);
    }

    const body = await readJson<RemoveBody>(request);
    const targetId = typeof body?.userId === "string" ? body.userId : "";
    if (!targetId) return json({ error: "Bitte ein Mitglied angeben." }, 400);
    if (targetId === user.id) return json({ error: "Du kannst dich nicht selbst entfernen – übertrage zuerst den Owner." }, 400);

    const targetRole = await getRole(env.DB, listId, targetId);
    if (!targetRole) return json({ error: "Mitglied nicht gefunden." }, 404);
    if (targetRole === "owner") return json({ error: "Ein Owner kann nicht entfernt werden." }, 400);

    await env.DB.prepare("DELETE FROM list_memberships WHERE list_id = ? AND user_id = ?")
      .bind(listId, targetId)
      .run();
    return json({ ok: true });
  });
}

interface TransferBody {
  userId?: unknown;
}

/**
 * POST /api/list/:id/owner – überträgt die Owner-Rolle an ein anderes Mitglied.
 * Nur der aktuelle Owner; das Ziel wird Owner, der Absender Member.
 */
export async function handleTransferOwner(request: Request, env: Env, listId: string): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    if (!(await isMember(env.DB, listId, user.id))) return notFound();
    const meta = await getListMeta(env.DB, listId);
    const role = await getRole(env.DB, listId, user.id);
    if (role !== "owner" && meta?.owner_id !== user.id) {
      return json({ error: "Nur der Owner kann die Liste übertragen.", role: role ?? null }, 403);
    }

    const body = await readJson<TransferBody>(request);
    const targetId = typeof body?.userId === "string" ? body.userId : "";
    if (!targetId) return json({ error: "Bitte ein Mitglied angeben." }, 400);
    if (targetId === user.id) return json({ error: "Du bist bereits Owner dieser Liste." }, 400);

    const targetRole = await getRole(env.DB, listId, targetId);
    if (!targetRole) return json({ error: "Das Ziel ist kein Mitglied dieser Liste." }, 404);

    await env.DB.batch([
      env.DB.prepare("UPDATE list_memberships SET role = 'member' WHERE list_id = ? AND user_id = ?").bind(listId, user.id),
      env.DB.prepare("UPDATE list_memberships SET role = 'owner' WHERE list_id = ? AND user_id = ?").bind(listId, targetId),
      env.DB.prepare("UPDATE lists SET owner_id = ? WHERE id = ?").bind(targetId, listId),
    ]);
    return json({ ok: true });
  });
}

/** POST /api/list/:id/leave – der aktuelle Nutzer verlässt die Liste (kein Owner). */
export async function handleLeaveList(request: Request, env: Env, listId: string): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    const role = await getRole(env.DB, listId, user.id);
    if (!role) return notFound();
    const meta = await getListMeta(env.DB, listId);
    if (role === "owner" || meta?.owner_id === user.id) {
      return json({ error: "Als Owner kannst du die Liste nicht verlassen – übertrage zuerst den Owner." }, 400);
    }
    await env.DB.prepare("DELETE FROM list_memberships WHERE list_id = ? AND user_id = ?")
      .bind(listId, user.id)
      .run();
    return json({ ok: true });
  });
}
