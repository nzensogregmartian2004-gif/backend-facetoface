import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Rendition = { height: number; width: number; bitrateKbps: number; file: string };

const profiles = [
  { height: 360, bitrateKbps: 800 },
  { height: 480, bitrateKbps: 1400 },
  { height: 720, bitrateKbps: 2800 },
  { height: 1080, bitrateKbps: 5000 },
];

function run(bin: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d.toString(); if (err.length > 8000) err = err.slice(-8000); });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error(err || `${bin} exited with ${code}`)));
  });
}

export async function transcodeToHls(input: string, sourceWidth: number, sourceHeight: number) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'f2f-video-'));
  const localInput = input;
  const maxHeight = Math.max(1, sourceHeight);
  const selected = profiles.filter(p => p.height <= maxHeight);
  if (!selected.length) selected.push(profiles[0]);
  const renditions: Rendition[] = [];
  try {
    for (const p of selected) {
      const out = path.join(dir, `${p.height}`);
      await fs.mkdir(out);
      const playlist = path.join(out, 'index.m3u8');
      const targetWidth = Math.max(2, Math.floor((sourceWidth / sourceHeight) * p.height / 2) * 2);
      await run('ffmpeg', ['-y','-i',localInput,'-vf',`scale=${targetWidth}:${p.height}`,'-c:v','libx264','-preset','veryfast','-b:v',`${p.bitrateKbps}k`,'-maxrate',`${Math.round(p.bitrateKbps*1.15)}k`,'-bufsize',`${p.bitrateKbps*2}k`,'-c:a','aac','-b:a','128k','-f','hls','-hls_time','4','-hls_playlist_type','vod','-hls_segment_filename',path.join(out,'%05d.ts'),playlist]);
      renditions.push({ height:p.height, width:targetWidth, bitrateKbps:p.bitrateKbps, file:out });
    }
    const master = '#EXTM3U\n#EXT-X-VERSION:3\n' + renditions.map(r => `#EXT-X-STREAM-INF:BANDWIDTH=${(r.bitrateKbps+128)*1000},RESOLUTION=${r.width}x${r.height}\n${r.height}/index.m3u8`).join('\n') + '\n';
    return { dir, master, renditions };
  } catch (e) {
    await fs.rm(dir, {recursive:true,force:true});
    throw e;
  }
}

export async function generateThumbnail(input: string, output: string) { await run('ffmpeg', ['-y','-ss','00:00:01','-i',input,'-frames:v','1','-vf','scale=640:-2','-q:v','4',output]); }

export async function cleanupTranscodeDir(dir: string) { await fs.rm(dir, { recursive:true, force:true }); }
export async function listFiles(dir: string) { return fs.readdir(dir, {recursive:true, withFileTypes:true}).then(xs => xs.filter(x=>x.isFile()).map(x=>path.relative(dir, path.join(x.parentPath ?? dir, x.name)))); }
