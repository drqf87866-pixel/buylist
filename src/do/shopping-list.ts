import { json } from "../util";
import type { ShoppingItem, ShoppingList } from "../types";

const STORAGE_KEY = "list";

interface WsMeta {
  userId: string;
  displayName: string;
}

interface InitBody {
  listId: string;
  name: string;
}

interface AddItemsBody {
  listId: string;
  displayName: string;
  items: { name?: unknown; menge?: unknown }[];
}

/**
 * Ein Durable Object pro Einkaufsliste: hält den aktuellen Listenzustand im
 * Memory (und persistent im SQLite-backed DO-Storage) und broadcastet jede
 * Änderung an alle verbundenen WebSocket-Clients (Hibernation API – das DO
 * schläft bei Inaktivität, "ping" wird per Auto-Response beantwortet).
 */
export class ShoppingListDO {
  // undefined = noch nicht geladen, null = geladen und leer
  private cached: ShoppingList | null | undefined = undefined;

  constructor(private state: DurableObjectState) {
    // Heartbeat ohne Wake-up: "ping" vom Client beantwortet die Runtime direkt.
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/init": {
        const body = (await request.json()) as InitBody;
        await this.ensureList(body.listId, body.name);
        return json({ ok: true });
      }
      case "/snapshot": {
        const list = await this.ensureList(
          url.searchParams.get("id") ?? crypto.randomUUID(),
          url.searchParams.get("name") ?? "Einkaufsliste"
        );
        return json(list);
      }
      case "/add-items": {
        return this.handleAddItems(request);
      }
      case "/ws": {
        return this.handleWs(request, url);
      }
      default:
        return json({ error: "Not Found" }, 404);
    }
  }

  /**
   * Fügt mehrere Artikel auf einmal hinzu (z. B. Zutaten eines generierten
   * Rezepts) und broadcastet genau einmal, damit alle Clients synchron bleiben.
   */
  private async handleAddItems(request: Request): Promise<Response> {
    let body: AddItemsBody;
    try {
      body = (await request.json()) as AddItemsBody;
    } catch {
      return json({ error: "Ungültiger Body." }, 400);
    }

    const displayName = body.displayName || "Unbekannt";
    const incoming = Array.isArray(body.items) ? body.items.slice(0, 50) : [];
    const list = await this.ensureList(
      body.listId ?? crypto.randomUUID(),
      "Einkaufsliste"
    );

    let changed = false;
    let added = 0;
    for (const raw of incoming) {
      const name = typeof raw?.name === "string" ? raw.name.trim().slice(0, 120) : "";
      if (!name) continue;
      const menge =
        typeof raw?.menge === "string" && raw.menge.trim() ? raw.menge.trim().slice(0, 40) : undefined;
      list.items.push({
        id: crypto.randomUUID(),
        name,
        menge,
        erledigt: false,
        hinzugefuegtVon: displayName,
        timestamp: Date.now(),
      });
      changed = true;
      added += 1;
    }

    if (!changed) return json({ error: "Keine gültigen Artikel." }, 400);

    this.cached = list;
    await this.state.storage.put(STORAGE_KEY, list);
    this.broadcast(list);
    return json({ ok: true, added });
  }

  private async getList(): Promise<ShoppingList | null> {
    if (this.cached === undefined) {
      this.cached = (await this.state.storage.get<ShoppingList>(STORAGE_KEY)) ?? null;
    }
    return this.cached;
  }

  private async ensureList(id: string, name: string): Promise<ShoppingList> {
    const existing = await this.getList();
    if (existing) return existing;
    const list: ShoppingList = { id, name, items: [] };
    this.cached = list;
    await this.state.storage.put(STORAGE_KEY, list);
    return list;
  }

  private async handleWs(request: Request, url: URL): Promise<Response> {
    if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
      return json({ error: "WebSocket-Upgrade erwartet." }, 426);
    }

    const pair = new WebSocketPair();
    const server = pair[1];
    this.state.acceptWebSocket(server);

    const meta: WsMeta = {
      // Der Worker setzt diese Header serverseitig nach Session- und
      // Membership-Prüfung; eingehende Client-Werte werden vorher entfernt.
      userId: request.headers.get("x-user-id") ?? "",
      displayName: request.headers.get("x-display-name") || "Unbekannt",
    };
    server.serializeAttachment(meta);

    const list = await this.ensureList(
      url.searchParams.get("id") ?? crypto.randomUUID(),
      url.searchParams.get("name") ?? "Einkaufsliste"
    );
    server.send(JSON.stringify({ type: "sync", list }));

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message === "ping") return;

    let msg: { type?: string; itemId?: string; name?: string; menge?: string; erledigt?: boolean };
    try {
      msg = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Ungültige Nachricht." }));
      return;
    }

    const list = await this.getList();
    if (!list) return;

    let changed = false;

    if (msg.type === "add") {
      const name = typeof msg.name === "string" ? msg.name.trim().slice(0, 120) : "";
      if (!name) {
        ws.send(JSON.stringify({ type: "error", message: "Der Artikel braucht einen Namen." }));
        return;
      }
      const menge =
        typeof msg.menge === "string" && msg.menge.trim() ? msg.menge.trim().slice(0, 40) : undefined;
      const meta = ws.deserializeAttachment() as WsMeta | null;
      const item: ShoppingItem = {
        id: crypto.randomUUID(),
        name,
        menge,
        erledigt: false,
        hinzugefuegtVon: meta?.displayName || "Unbekannt",
        timestamp: Date.now(),
      };
      list.items.push(item);
      changed = true;
    } else if (msg.type === "toggle") {
      const item = list.items.find((i) => i.id === msg.itemId);
      if (item && typeof msg.erledigt === "boolean") {
        item.erledigt = msg.erledigt;
        changed = true;
      }
    } else if (msg.type === "delete") {
      const before = list.items.length;
      list.items = list.items.filter((i) => i.id !== msg.itemId);
      changed = list.items.length !== before;
    }

    if (!changed) return;

    this.cached = list;
    await this.state.storage.put(STORAGE_KEY, list);
    this.broadcast(list);
  }

  async webSocketClose(_ws: WebSocket): Promise<void> {
    // Client getrennt – der Listenzustand liegt im Storage, nichts zu tun.
  }

  async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    console.error("ShoppingListDO: WebSocket-Fehler", error);
  }

  private broadcast(list: ShoppingList): void {
    const payload = JSON.stringify({ type: "sync", list });
    for (const socket of this.state.getWebSockets()) {
      try {
        socket.send(payload);
      } catch {
        // Tote Verbindungen räumt webSocketClose/-error auf.
      }
    }
  }
}
