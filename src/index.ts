import { handleLogin, handleLogout, handleMe, handleRegister } from "./auth";
import { handleCreateList, handleGetLists, handleInvite, handleJoin, handleSnapshot, isMember } from "./lists";
import { getSessionUser } from "./session";
import { json } from "./util";
import type { Env } from "./types";

export { ShoppingListDO } from "./do/shopping-list";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await routeApi(request, env, url);
      } catch (err) {
        console.error("API-Fehler:", err);
        return json({ error: "Interner Serverfehler." }, 500);
      }
    }

    // Alle Nicht-API-Requests: statische Assets, bei Nicht-Treffer SPA-Fallback
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

const LIST_ROUTE_RE = /^\/api\/list\/([A-Za-z0-9-]+)\/(snapshot|ws|invite)$/;

async function routeApi(request: Request, env: Env, url: URL): Promise<Response> {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/auth/register" && method === "POST") return handleRegister(request, env);
  if (pathname === "/api/auth/login" && method === "POST") return handleLogin(request, env);
  if (pathname === "/api/auth/logout" && method === "POST") return handleLogout(request, env);
  if (pathname === "/api/auth/me" && method === "GET") return handleMe(request, env);

  if (pathname === "/api/lists") {
    if (method === "GET") return handleGetLists(request, env);
    if (method === "POST") return handleCreateList(request, env);
  }

  if (pathname === "/api/join" && method === "POST") return handleJoin(request, env);

  const match = pathname.match(LIST_ROUTE_RE);
  if (match) {
    const [, listId, action] = match;
    if (action === "snapshot" && method === "GET") return handleSnapshot(request, env, listId);
    if (action === "invite" && method === "GET") return handleInvite(request, env, listId);
    if (action === "ws" && method === "GET") return handleWs(request, env, listId);
  }

  return json({ error: "Nicht gefunden." }, 404);
}

/**
 * WebSocket-Upgrade: erst Session und Mitgliedschaft prüfen, dann an das DO
 * weiterreichen. Der User-Kontext wird serverseitig als Header übergeben
 * (eingehende gleichnamige Header werden entfernt – kein Spoofing).
 */
async function handleWs(request: Request, env: Env, listId: string): Promise<Response> {
  const session = await getSessionUser(env.DB, request);
  if (!session) return json({ error: "Nicht eingeloggt." }, 401);

  if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
    return json({ error: "WebSocket-Upgrade erwartet." }, 426);
  }

  const meta = await env.DB.prepare("SELECT name FROM lists WHERE id = ?").bind(listId).first<{ name: string }>();
  if (!meta || !(await isMember(env.DB, listId, session.user.id))) {
    return json({ error: "Liste nicht gefunden." }, 404);
  }

  const stub = env.SHOPPING_LIST_DO.get(env.SHOPPING_LIST_DO.idFromName(listId));
  const doUrl = new URL(request.url);
  doUrl.pathname = "/ws";
  doUrl.search = `?id=${encodeURIComponent(listId)}&name=${encodeURIComponent(meta.name)}`;

  const headers = new Headers(request.headers);
  headers.delete("x-user-id");
  headers.delete("x-display-name");
  headers.set("x-user-id", session.user.id);
  headers.set("x-display-name", session.user.displayName);

  return stub.fetch(new Request(doUrl, { method: "GET", headers }));
}
