/**
 * SQLite driver using Bun's built-in `bun:sqlite`.
 *
 * Chosen when we detect the Bun runtime (see db/index.ts). Bun does NOT
 * expose Node's `node:sqlite` — it has its own module with a nearly
 * identical API.
 *
 * Kept as a separate file so `import("./sqlite")` (node) never even
 * touches `bun:sqlite`, and vice-versa.
 *
 * Vale o mesmo aviso do driver de Node: em producao no Render este banco e
 * efemero. Ver ./sqlite.ts.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Db } from "./index";
import { SqliteCore, type SqliteHandle } from "./sqlite-core";

export class BunSqliteDb extends SqliteCore implements Db {
  private readonly path: string;

  constructor(path: string) {
    super();
    this.path = resolve(path);
  }

  async init(): Promise<void> {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // Dynamic import guarded pela deteccao de runtime em db/index.ts —
    // este arquivo so roda no Bun.
    const mod = (await import("bun:sqlite")) as unknown as {
      Database: new (path: string) => SqliteHandle;
    };
    this.db = new mod.Database(this.path);
    this.createSchema();
  }
}
