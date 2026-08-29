export interface Env {
  DB: D1Database;
  SHOPPING_LIST_DO: DurableObjectNamespace;
  ASSETS: Fetcher;
}

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
  createdAt: number;
}

export interface ListMeta {
  id: string;
  name: string;
  ownerId: string;
  inviteToken: string;
  createdAt: number;
}

export interface ShoppingItem {
  id: string;
  name: string;
  menge?: string;
  erledigt: boolean;
  hinzugefuegtVon: string;
  timestamp: number;
}

export interface ShoppingList {
  id: string;
  name: string;
  items: ShoppingItem[];
}

/** Client -> Durable Object */
export type ClientMessage =
  | { type: "add"; name: string; menge?: string }
  | { type: "toggle"; itemId: string; erledigt: boolean }
  | { type: "delete"; itemId: string };

/** Durable Object -> Client */
export type ServerMessage =
  | { type: "sync"; list: ShoppingList }
  | { type: "error"; message: string };

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
}
