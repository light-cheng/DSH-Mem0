/**
 * Legacy config locations.
 *
 * Before DSH-Mem0 had its own `~/.dsh/mem0/` folder, the local Mem0 OSS setup
 * it grew out of lived in a Hermes agent install: the Mem0 config at
 * `~/.hermes/mem0.json` and the Python virtualenv at
 * `~/.hermes/hermes-agent/venv`. Existing setups still work without moving
 * anything, so these paths are checked, read-only, *after* the `~/.dsh/mem0/`
 * defaults and only when `mem0ConfigPath` / `pythonPath` are not set.
 *
 * This file is the only place that knows about them. New installs never need
 * them; to stop using them, set `mem0ConfigPath` and `pythonPath` or move the
 * files to `~/.dsh/mem0/oss.json` and `~/.dsh/mem0/venv`.
 */
import os from 'node:os'
import path from 'node:path'

/** Mem0 OSS config files to try after `~/.dsh/mem0/oss.json`, in order. */
export const LEGACY_MEM0_CONFIGS = Object.freeze([path.join(os.homedir(), '.hermes', 'mem0.json')])

/** Python interpreters to try after `~/.dsh/mem0/venv/bin/python`, in order. */
export const LEGACY_PYTHONS = Object.freeze([path.join(os.homedir(), '.hermes', 'hermes-agent', 'venv', 'bin', 'python')])
