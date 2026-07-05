import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CompiledAsset {
  name: string;
  content: string;
  mime: string;
  etag: string;
}

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

export function compileAssets(assetsDir: string): CompiledAsset[] {
  const compiledAssets: CompiledAsset[] = [];
  if (!fs.existsSync(assetsDir)) return compiledAssets;

  const scanAssets = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        scanAssets(path.join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      const mime = MIME_TYPES[ext];
      if (!mime) continue;

      const content = fs.readFileSync(path.join(dir, entry.name), 'utf-8');
      const etag = '"' + crypto.createHash('md5').update(content).digest('hex').slice(0, 12) + '"';
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      compiledAssets.push({ name, content, mime, etag });
    }
  };

  scanAssets(assetsDir, '');
  return compiledAssets;
}
