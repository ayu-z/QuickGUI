import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { Project } from './types';
import { serializeProject } from './project';
import { validateProject } from './validation';

// Keep these portable filename rules in sync with native project_file::suggested_filename.
export function projectFilename(name: string): string {
  let stem = '';
  let bytes = 0;
  for (const character of name.trim().replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/g, '_')) {
    const size = strToU8(character).length;
    if (bytes + size > 200) break;
    stem += character;
    bytes += size;
  }
  stem = stem.replace(/[ .]+$/, '') || 'project';
  if (/^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(stem)) stem = `_${stem}`;
  return `${stem}.qgui`;
}

export function exportProject(project: Project, drafts: Record<string, string> = {}): Uint8Array {
  if (Object.keys(drafts).length)
    throw new Error('Resolve unapplied CODE drafts before exporting.');
  validateProject(project);
  return zipSync(
    {
      'quickgui.json': strToU8(serializeProject(project)),
      'README.txt': strToU8(
        `QuickGUI project format v${project.schemaVersion}\nOpen quickgui.json or this .qgui archive in QuickGUI.\nAssets and C sources are embedded. Credentials should not be stored in project files.\n`,
      ),
    },
    { level: 6 },
  );
}
export function importProject(bytes: Uint8Array): Project {
  if (bytes.length > 30_000_000) throw new Error('Project exceeds the 30 MB import limit');
  let text: string;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    let oversized = false;
    const files = unzipSync(bytes, {
      filter: (entry) => {
        if (entry.name !== 'quickgui.json') return false;
        if (entry.originalSize > 30_000_000) {
          oversized = true;
          return false;
        }
        return true;
      },
    });
    if (oversized) throw new Error('Expanded project exceeds the 30 MB import limit');
    if (!files['quickgui.json']) throw new Error('Archive is missing quickgui.json');
    text = strFromU8(files['quickgui.json']);
  } else text = strFromU8(bytes);
  return validateProject(JSON.parse(text));
}
export function download(name: string, data: BlobPart, type = 'application/octet-stream') {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
