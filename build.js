// 分两步打包：先 --dir 生成 win-unpacked，替换入口为 launcher，再用 --prepackaged 打 nsis/portable
// 说明：electron-builder 的产物目录由 package.json 的 build.directories.output 决定（不是 release/），
//       入口 exe 名字由 productName 决定，这里都不写死，改成运行时探测。
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const OUT = path.resolve(ROOT, (pkg.build && pkg.build.directories && pkg.build.directories.output) || 'release');
const UNPACKED = path.join(OUT, 'win-unpacked');
const EB = path.join(ROOT, 'node_modules', '.bin', 'electron-builder.cmd');
const LAUNCHER = path.join(ROOT, 'launcher', 'zhibo-launcher.exe');
const CORE_NAME = 'zhibo-core.exe';

/* 构建期目录全部落在工程内（.cache/），换机器、换盘符都不用改代码。
 * NSIS 打包阶段会 mkdtemp，父目录必须先存在，这里顺手建好。 */
const CACHE = path.join(ROOT, '.cache');
const TMP = path.join(CACHE, 'tmp');
const EB_CACHE = path.join(CACHE, 'electron-builder');
for (const d of [TMP, EB_CACHE]) fs.mkdirSync(d, { recursive: true });

const env = { ...process.env,
  ELECTRON_RUN_AS_NODE: '',
  TEMP: TMP, TMP: TMP,
  ELECTRON_CACHE: path.join(CACHE, 'electron'),
  ELECTRON_BUILDER_CACHE: EB_CACHE,
};
const run = (args) => execFileSync(EB, args, { cwd: ROOT, env, stdio: 'inherit', shell: true });

/** 找出 win-unpacked 根目录下 Electron 自带的那个入口 exe（productName 命名，且与 electron.exe 同尺寸） */
function findEntryExe() {
  const cands = fs.readdirSync(UNPACKED)
    .filter((f) => /\.exe$/i.test(f))
    .filter((f) => f.toLowerCase() !== CORE_NAME)
    .map((f) => path.join(UNPACKED, f))
    .filter((p) => { try { return fs.statSync(p).size > 100 * 1024 * 1024; } catch (e) { return false; } });
  if (!cands.length) throw new Error('win-unpacked 里找不到入口 exe：' + UNPACKED);
  return cands[0];
}

console.log('[1/3] 打包 win-unpacked → ' + UNPACKED);
run(['--win', '--x64', '--dir']);

console.log('[2/3] 替换入口 exe ...');
const entry = findEntryExe();
const core = path.join(UNPACKED, CORE_NAME);
if (!fs.existsSync(LAUNCHER)) throw new Error('找不到 launcher: ' + LAUNCHER);
if (fs.existsSync(core)) fs.rmSync(core, { force: true });
fs.renameSync(entry, core);           // Electron 本体 → zhibo-core.exe
fs.copyFileSync(LAUNCHER, entry);     // launcher  → 原入口名（用户双击这个）
console.log('    ' + path.basename(entry) + ' (launcher)  +  ' + CORE_NAME + ' (electron)');

console.log('[3/3] 打 nsis + portable ...');
run(['--win', '--x64', '--prepackaged', UNPACKED]);

const arts = fs.readdirSync(OUT).filter((f) => /\.exe$|\.blockmap$/.test(f));
console.log('完成，产物：' + OUT);
for (const a of arts) {
  const st = fs.statSync(path.join(OUT, a));
  console.log('  ' + a + '  ' + st.size + ' 字节  ' + st.mtime.toISOString());
}
