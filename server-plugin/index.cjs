'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PLUGIN_ID = 'st-preset-weaver';
const STATE_SCHEMA_VERSION = 1;
const DEFAULT_SETTINGS = Object.freeze({
  autoBackup: true,
  backupRetention: 50,
  theme: 'dark',
});

function emptyState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    modules: {},
    groups: {},
    presets: {},
    settings: { ...DEFAULT_SETTINGS },
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeId(value) {
  return /^[A-Za-z0-9_-]{1,120}$/.test(value) ? value : null;
}

function backupId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
}

function normalizeState(input) {
  const state = emptyState();
  if (!isPlainObject(input)) return state;

  for (const key of ['modules', 'groups', 'presets']) {
    if (isPlainObject(input[key])) state[key] = input[key];
  }

  if (isPlainObject(input.settings)) {
    state.settings = {
      ...state.settings,
      ...input.settings,
    };
    state.settings.autoBackup = state.settings.autoBackup === true;
    state.settings.backupRetention = Math.max(
      1,
      Math.min(500, Number(state.settings.backupRetention) || DEFAULT_SETTINGS.backupRetention),
    );
    state.settings.theme = state.settings.theme === 'light' ? 'light' : 'dark';
  }

  return state;
}

async function ensureDirs(dirs) {
  await Promise.all([...dirs.values()].map(async dir => {
    await fs.mkdir(dir, { recursive: true });
  }));
}

function pathsFor(user) {
  const root = user?.directories?.root;
  if (!root || typeof root !== 'string') {
    throw new Error('Authenticated SillyTavern user directory is unavailable.');
  }

  const base = path.resolve(root, 'extensions-data', PLUGIN_ID);
  const backups = path.join(base, 'backups');
  const dirs = new Map([['base', base], ['backups', backups]]);
  return {
    root,
    base,
    backups,
    dirs,
    stateFile: path.join(base, 'state.json'),
    manifestFile: path.join(base, 'backups', 'manifest.json'),
  };
}

async function atomicWrite(filePath, data) {
  const tempPath = `${filePath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tempPath, data, 'utf-8');
  await fs.rename(tempPath, filePath);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function readState(paths) {
  await ensureDirs(paths.dirs);
  const state = normalizeState(await readJson(paths.stateFile, null));
  await atomicWrite(paths.stateFile, JSON.stringify(state, null, 2));
  return state;
}

async function writeState(paths, input) {
  const state = normalizeState(input);
  await ensureDirs(paths.dirs);
  await atomicWrite(paths.stateFile, JSON.stringify(state, null, 2));
  return state;
}

async function readManifest(paths) {
  await ensureDirs(paths.dirs);
  const manifest = await readJson(paths.manifestFile, []);
  return Array.isArray(manifest) ? manifest : [];
}

async function writeManifest(paths, manifest) {
  await atomicWrite(paths.manifestFile, JSON.stringify(manifest, null, 2));
}

async function createBackup(paths, body, source) {
  if (!body || !isPlainObject(body.preset)) {
    return { status: 400, payload: { error: 'A preset object is required.' } };
  }

  const kind = body.kind === 'manual' ? 'manual' : 'auto';
  const presetName = typeof body.presetName === 'string' ? body.presetName.slice(0, 200) : '';
  const id = backupId();
  const record = {
    id,
    createdAt: new Date().toISOString(),
    kind,
    source,
    presetName,
  };
  const manifest = await readManifest(paths);
  manifest.unshift(record);
  const retention = Number(body.retention) || 50;

  while (manifest.length > retention) {
    const removed = manifest.pop();
    const removedId = safeId(removed.id);
    if (removedId) {
      await fs.rm(path.join(paths.backups, `${removedId}.json`), { force: true });
    }
  }

  await atomicWrite(
    path.join(paths.backups, `${id}.json`),
    JSON.stringify({ ...record, preset: body.preset }, null, 2),
  );
  await writeManifest(paths, manifest);
  return { status: 200, payload: record };
}

async function getBackup(paths, id) {
  const safe = safeId(id);
  if (!safe) return null;
  const manifest = await readManifest(paths);
  const record = manifest.find(item => item?.id === safe);
  if (!record) return null;
  return await readJson(path.join(paths.backups, `${safe}.json`), null);
}

function pluginApi(router) {
  router.get('/health', (request, response) => {
    response.json({
      ok: true,
      plugin: PLUGIN_ID,
      user: Boolean(request.user?.directories?.root),
    });
  });

  router.get('/state', async (request, response) => {
    try {
      response.json(await readState(pathsFor(request.user)));
    } catch (error) {
      response.status(500).json({ error: error.message });
    }
  });

  router.put('/state', async (request, response) => {
    try {
      response.json(await writeState(pathsFor(request.user), request.body));
    } catch (error) {
      response.status(500).json({ error: error.message });
    }
  });

  router.get('/backups', async (request, response) => {
    try {
      const paths = pathsFor(request.user);
      response.json(await readManifest(paths));
    } catch (error) {
      response.status(500).json({ error: error.message });
    }
  });

  router.post('/backups', async (request, response) => {
    try {
      const paths = pathsFor(request.user);
      const source = request.body?.source === 'manual' ? 'manual' : 'auto';
      const result = await createBackup(paths, request.body, source);
      response.status(result.status).json(result.payload);
    } catch (error) {
      response.status(500).json({ error: error.message });
    }
  });

  router.get('/backups/:id', async (request, response) => {
    try {
      const paths = pathsFor(request.user);
      const backup = await getBackup(paths, request.params.id);
      if (!backup) return response.status(404).json({ error: 'Backup not found.' });
      response.json(backup);
    } catch (error) {
      response.status(500).json({ error: error.message });
    }
  });

  router.delete('/backups/:id', async (request, response) => {
    try {
      const paths = pathsFor(request.user);
      const id = safeId(request.params.id);
      if (!id) return response.status(400).json({ error: 'Invalid backup id.' });
      const manifest = await readManifest(paths);
      const next = manifest.filter(item => item?.id !== id);
      if (next.length === manifest.length) return response.status(404).json({ error: 'Backup not found.' });
      await fs.rm(path.join(paths.backups, `${id}.json`), { force: true });
      await writeManifest(paths, next);
      response.json({ ok: true });
    } catch (error) {
      response.status(500).json({ error: error.message });
    }
  });

  router.get('/export', async (request, response) => {
    try {
      const paths = pathsFor(request.user);
      const state = await readState(paths);
      const manifest = await readManifest(paths);
      const backups = [];
      for (const record of manifest) {
        const backup = await getBackup(paths, record.id);
        if (backup) backups.push(backup);
      }
      response.json({ schemaVersion: STATE_SCHEMA_VERSION, exportedAt: new Date().toISOString(), state, backups });
    } catch (error) {
      response.status(500).json({ error: error.message });
    }
  });

  router.post('/import', async (request, response) => {
    try {
      const paths = pathsFor(request.user);
      const body = request.body;
      if (!isPlainObject(body?.state)) {
        return response.status(400).json({ error: 'A state object is required.' });
      }

      const state = await writeState(paths, body.state);
      let importedBackups = 0;
      if (Array.isArray(body.backups)) {
        const manifest = [];
        await fs.rm(paths.backups, { recursive: true, force: true });
        await fs.mkdir(paths.backups, { recursive: true });
        for (const backup of body.backups) {
          if (!isPlainObject(backup) || !safeId(backup.id) || !isPlainObject(backup.preset)) continue;
          manifest.push({
            id: backup.id,
            createdAt: backup.createdAt || new Date().toISOString(),
            kind: backup.kind === 'manual' ? 'manual' : 'auto',
            source: backup.source || 'imported',
            presetName: backup.presetName || '',
          });
          await atomicWrite(
            path.join(paths.backups, `${backup.id}.json`),
            JSON.stringify(backup, null, 2),
          );
          importedBackups += 1;
        }
        await writeManifest(paths, manifest);
      }

      response.json({ ok: true, state, importedBackups });
    } catch (error) {
      response.status(500).json({ error: error.message });
    }
  });
}

async function init(router) {
  pluginApi(router);
}

async function exit() {}

module.exports = {
  init,
  exit,
  info: {
    id: PLUGIN_ID,
    name: 'Preset Weaver Server',
    description: 'Per-user storage, backup, and import/export APIs for Preset Weaver.',
  },
};
