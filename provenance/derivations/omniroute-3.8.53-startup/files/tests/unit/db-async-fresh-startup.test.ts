import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Use separate production-mode processes: the migration safety gate is disabled
// under node --test, and core resolves DATA_DIR and its singleton at import time.
const startup = `
  import assert from 'node:assert/strict';
  import fs from 'node:fs';
  import path from 'node:path';
  import { DatabaseSync } from 'node:sqlite';
  import { isAutomatedTestProcess } from './src/shared/utils/testProcess.ts';
  import { listBackupIds, resolveBackupFile } from './src/lib/db/backupPaths.ts';
  import * as core from './src/lib/db/core.ts';
  const file = path.join(process.env.DATA_DIR, 'storage.sqlite');
  const scenario = process.env.STARTUP_SCENARIO;
  assert.equal(isAutomatedTestProcess(), false, 'the production migration guard must be active');
  if (scenario === 'existing') {
    // An existing, genuinely empty SQLite database must not be mistaken for a
    // fresh file: the migration guard must still abort and retain a snapshot.
    const seed = new DatabaseSync(file);
    seed.exec("CREATE TABLE existing_marker (value TEXT); INSERT INTO existing_marker VALUES ('preserve me')");
    seed.close();
  } else if (scenario === 'corrupt') {
    fs.writeFileSync(file, 'not a sqlite database');
  } else {
    assert.equal(fs.existsSync(file), false);
  }
  try {
    if (scenario === 'existing') {
      await assert.rejects(core.ensureDbInitialized(), { name: 'MigrationSafetyAbortError' });
      const backupDir = path.join(process.env.DATA_DIR, 'db_backups');
      const backups = listBackupIds(backupDir)
        .filter(name => /^db_state-[a-f0-9]{64}_pre-migration\\.sqlite$/.test(name));
      assert.equal(backups.length, 1, 'existing database must be snapshotted');
      const snapshot = new DatabaseSync(resolveBackupFile(backupDir, backups[0]), { readOnly: true });
      try { assert.equal(snapshot.prepare('SELECT value FROM existing_marker').get().value, 'preserve me'); }
      finally { snapshot.close(); }
    } else if (scenario === 'corrupt') {
      await assert.rejects(core.ensureDbInitialized());
      const candidates = fs.readdirSync(process.env.DATA_DIR)
        .filter(name => name === 'storage.sqlite' || name.startsWith('storage.sqlite.probe-failed-'));
      assert.ok(candidates.some(name => fs.readFileSync(path.join(process.env.DATA_DIR, name)).equals(Buffer.from('not a sqlite database'))), 'corrupt input must be preserved');
    } else {
      await core.ensureDbInitialized();
      const db = core.getDbInstance();
      assert.equal(db.driver === 'sql.js', scenario === 'fallback');
      assert.ok(db.prepare("SELECT version FROM _omniroute_migrations WHERE version='223'").get(), 'real migrations completed');
      db.prepare("INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run('startup-regression', 'key', 'value');
      assert.equal(db.prepare('SELECT value FROM key_value WHERE namespace=? AND key=?').get('startup-regression', 'key').value, 'value');
    }
  } finally { await core.shutdownDbInstance(); }
`;

for (const scenario of ["native", "fallback", "existing", "corrupt"]) {
  test(`async production startup preserves ${scenario} database semantics`, () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-async-startup-"));
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: dataDir, NODE_ENV: "production", STARTUP_SCENARIO: scenario,
        APP_LOG_TO_FILE: "false", OMNIROUTE_SKIP_DB_HEALTHCHECK: "1",
        OMNIROUTE_PACK_BOOT_SMOKE: "1", OMNIROUTE_PACK_BOOT_FORCE_SQLJS: scenario === "fallback" ? "1" : "0" };
      for (const key of ["VITEST", "NODE_OPTIONS", "NEXT_PHASE", "OMNIROUTE_BUILDING", "OMNIROUTE_MAX_PENDING_MIGRATIONS", "OMNIROUTE_MIGRATIONS_DIR", "OMNIROUTE_EXTRA_MIGRATIONS_DIRS", "DISABLE_SQLITE_AUTO_BACKUP"]) delete env[key];
      const child = spawnSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", startup], {
        cwd: process.cwd(), env, encoding: "utf8", timeout: 120_000,
      });
      assert.equal(child.status, 0, `${scenario}: ${child.error ?? ""}\n${child.stdout}\n${child.stderr}`);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
}
