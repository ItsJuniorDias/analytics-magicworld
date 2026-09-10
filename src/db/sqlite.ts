/**
 * SQLite driver using Node's built-in `node:sqlite` module.
 *
 * Why the built-in? Zero native compilation. Works on Node 22.11 out of the box
 * on Render, Fly, Railway, and Docker without a build toolchain.
 *
 * Requires Node >= 22.5. `engines` no package.json pede 22.11.0.
 *
 * ATENCAO: no Render este banco mora num disco EFEMERO. Ele some a cada
 * spin-down do plano free e a cada deploy. Este driver e para desenvolvimento
 * local. Se ele estiver ativo em producao, o dado nao esta sendo guardado —
 * GET /health diz qual driver subiu.
 *
 * Toda a logica de consulta vive em ./sqlite-core. Aqui fica so a abertura
 * do handle, que e a unica coisa que difere do driver do Bun.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Db } from "./index";
import { SqliteCore, type SqliteHandle } from "./sqlite-core";

export class SqliteDb extends SqliteCore implements Db {
  private readonly path: string;

  constructor(path: string) {
    super();
    this.path = resolve(path);
  }

  async init(): Promise<void> {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // Dynamic import so TS doesn't try to resolve node:sqlite at compile time
    // (types not yet stable in @types/node).
    const mod = (await import("node:sqlite")) as unknown as {
      DatabaseSync: new (path: string) => SqliteHandle;
    };
    this.db = new mod.DatabaseSync(this.path);
    this.createSchema();
  }
}
