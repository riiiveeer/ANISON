import { createNeteasePreviewService } from './service.js';

const input = process.argv.slice(2).join(' ').trim();
if (!input) {
  console.error('用法：npm run test:netease:smoke -- <网易云歌曲链接或 ID>');
  process.exitCode = 1;
} else {
  try {
    const preview = await createNeteasePreviewService().preview(input);
    console.log(JSON.stringify({
      song: preview.song,
      tracks: Object.fromEntries(Object.entries(preview.tracks).map(([key, value]) => [
        key,
        { available: value.available, format: value.format },
      ])),
      warnings: preview.warnings,
    }, null, 2));
  } catch (error) {
    console.error(`${error?.code || 'ERROR'}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
