import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function pruneUnusedIcons(directory) {
  for (const mobile of ['ios', 'android'])
    await rm(path.join(directory, mobile), { recursive: true, force: true });
  for (const file of await readdir(directory))
    if (/^(?:StoreLogo|Square\d+x\d+Logo)\.png$/.test(file)) await rm(path.join(directory, file));
}

export function resolveIconData(reference, project) {
  if (!reference) return null;
  const value = project?.assets?.find((asset) => asset.id === reference)?.data ?? reference;
  const match =
    /^data:(image\/(?:png|svg\+xml|x-icon|vnd.microsoft.icon));(base64),([\s\S]+)$/.exec(value);
  if (match)
    return {
      extension: match[1] === 'image/svg+xml' ? 'svg' : match[1] === 'image/png' ? 'png' : 'ico',
      bytes: Buffer.from(match[3], 'base64'),
    };
  const svg = /^data:image\/svg\+xml,(.*)$/s.exec(value);
  if (svg) return { extension: 'svg', bytes: Buffer.from(decodeURIComponent(svg[1])) };
  throw new Error(
    'Publish icons must be embedded PNG/SVG assets or data URLs, so the exported source remains self-contained.',
  );
}

export async function generateIcons(base = root, explicitInput) {
  let project = null;
  try {
    project = JSON.parse(await readFile(path.join(base, 'project.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const iconDir = path.join(base, 'src-tauri', 'icons');
  await mkdir(iconDir, { recursive: true });
  let input = explicitInput ? path.resolve(explicitInput) : path.join(iconDir, 'app.svg');
  const custom = !explicitInput && resolveIconData(project?.publish?.icon, project);
  if (custom) {
    input = path.join(iconDir, `publish-source.${custom.extension}`);
    await writeFile(input, custom.bytes);
  }
  const cli = path.join(path.dirname(require.resolve('@tauri-apps/cli/package.json')), 'tauri.js');
  const run = (source, destination) => {
    const result = spawnSync(process.execPath, [cli, 'icon', source, '--output', destination], {
      cwd: base,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Tauri icon generation failed (${result.status})`);
  };
  run(input, iconDir);
  await pruneUnusedIcons(iconDir);
  const shortcut = resolveIconData(project?.publish?.shortcutIcon, project);
  if (shortcut) {
    const source = path.join(iconDir, `shortcut-source.${shortcut.extension}`);
    await writeFile(source, shortcut.bytes);
    run(source, path.join(iconDir, 'shortcut'));
    await pruneUnusedIcons(path.join(iconDir, 'shortcut'));
  }
  if (project) {
    const configPath = path.join(base, 'src-tauri', 'tauri.conf.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.bundle.windows ??= {};
    config.bundle.windows.nsis ??= {};
    config.bundle.windows.nsis.installerHooks = 'installer-hooks.nsh';
    config.bundle.resources ??= {};
    if (Array.isArray(config.bundle.resources))
      throw new Error('Expected a resource map in the exported Tauri configuration');
    const useCustomShortcut = Boolean(shortcut);
    if (useCustomShortcut) config.bundle.resources['icons/shortcut/icon.ico'] = 'shortcut.ico';
    const desktop = project.publish.desktopShortcut;
    const shortcutPath = '$DESKTOP\\${PRODUCTNAME}.lnk';
    const iconPath = useCustomShortcut
      ? '$INSTDIR\\shortcut.ico'
      : '$INSTDIR\\${MAINBINARYNAME}.exe';
    const hooks = `; Generated from project.json. Names are supplied by Tauri's NSIS template.\n!macro NSIS_HOOK_POSTINSTALL\n  ${desktop ? `CreateShortCut "${shortcutPath}" "$INSTDIR\\\${MAINBINARYNAME}.exe" "" "${iconPath}" 0` : `Delete "${shortcutPath}"`}\n!macroend\n!macro NSIS_HOOK_PREUNINSTALL\n  Delete "${shortcutPath}"\n!macroend\n`;
    await writeFile(path.join(base, 'src-tauri', 'installer-hooks.nsh'), hooks);
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateIcons(root, process.argv[2]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
