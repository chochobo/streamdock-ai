import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Environment for the Python workers (games, scenes, sounds).
 *
 * Python writes `__pycache__` next to the modules it imports. In the app
 * those modules sit inside the code-signed bundle, so the first run broke
 * the signature (a sealed resource is missing or invalid) and the build
 * script then refused to replace the app (#43). Sending the bytecode to a
 * per-user cache keeps the bundle exactly as it was signed and still lets
 * Python skip recompiling.
 */
export function pythonEnv(base = process.env, home = os.homedir()) {
  const env = { ...base };
  if (!env.PYTHONPYCACHEPREFIX) {
    env.PYTHONPYCACHEPREFIX = path.join(home, '.cache', 'streamdock-ai', 'pycache');
    // Python would create it with the umask's mode; keep other users out of code it will load.
    try { mkdirSync(env.PYTHONPYCACHEPREFIX, { recursive: true, mode: 0o700 }); } catch { /* Python creates it if this fails. */ }
  }
  return env;
}
