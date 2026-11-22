/**
 * Loaded before every test file (`npm test` runs `node --import` with this).
 *
 * The plugin's defaults live under the home directory: `~/.dsh/mem0/`
 * (memory.sqlite, oss.json, failures.json) and `~/.dsh/.credentials.yaml`.
 * A test that forgets a path must not read or write
 * the developer's real files, so HOME (USERPROFILE on Windows) and DSH_HOME
 * point at a fresh temporary directory for the whole test process.
 * os.homedir() follows HOME, and lib/config.js computes its defaults at
 * import time, after this runs.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

if (!process.env.DSH_MEM0_TEST_HOME) {
  const realHome = os.homedir()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-test-home-'))
  process.env.DSH_MEM0_TEST_REAL_HOME = realHome
  process.env.DSH_MEM0_TEST_HOME = home
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.DSH_HOME = path.join(home, '.dsh')
  // Nothing here runs mem0 itself; set anyway so no tool writes ~/.mem0.
  process.env.MEM0_TELEMETRY = 'false'
  process.env.MEM0_DIR = path.join(home, '.mem0')
  // oMLX's settings (its API key) are read only from the test home.
  process.env.OMLX_BASE_PATH = path.join(home, '.omlx')
  process.on('exit', () => {
    try {
      fs.rmSync(home, { recursive: true, force: true })
    } catch {
      // best effort
    }
  })
}
