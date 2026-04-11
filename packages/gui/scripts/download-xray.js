const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const AdmZip = require('adm-zip');

const VERSION = '26.3.27';
const BASE_URL = `https://github.com/XTLS/Xray-core/releases/download/v${VERSION}/`;

const TARGETS = [
  { os: 'win', arch: 'x64', file: 'Xray-windows-64.zip' },
  { os: 'win', arch: 'ia32', file: 'Xray-windows-32.zip' },
  { os: 'win', arch: 'arm64', file: 'Xray-windows-arm64-v8a.zip' },
  { os: 'mac', arch: 'x64', file: 'Xray-macos-64.zip' },
  { os: 'mac', arch: 'arm64', file: 'Xray-macos-arm64-v8a.zip' },
  { os: 'linux', arch: 'x64', file: 'Xray-linux-64.zip' },
  { os: 'linux', arch: 'arm64', file: 'Xray-linux-arm64-v8a.zip' },
  { os: 'linux', arch: 'armv7l', file: 'Xray-linux-arm32-v7a.zip' }
];

const EXTRA_DIR = path.join(__dirname, '../extra/xray');
const CACHE_DIR = path.join(__dirname, '../node_modules/.cache/xray-downloads');

function getMacLipoArch(targetArch) {
  if (targetArch === 'x64') {
    return 'x86_64';
  }
  if (targetArch === 'arm64') {
    return 'arm64';
  }
  throw new Error(`Unsupported mac arch for lipo thinning: ${targetArch}`);
}

function getMacBinaryArchs(exePath) {
  const archOutput = execFileSync('lipo', ['-archs', exePath], { encoding: 'utf8' }).trim();
  const archs = archOutput.split(/\s+/).filter(Boolean);

  if (archs.length === 0) {
    throw new Error(`Unable to detect mac binary architectures for ${exePath}`);
  }

  return archs;
}

function thinMacBinary(exePath, targetArch) {
  if (process.platform !== 'darwin') {
    return;
  }

  const lipoArch = getMacLipoArch(targetArch);
  const beforeInfo = execFileSync('lipo', ['-info', exePath], { encoding: 'utf8' }).trim();
  const beforeArchs = getMacBinaryArchs(exePath);
  console.log(`[Mac] lipo info before thinning (${targetArch}): ${beforeInfo}`);
  console.log(`[Mac] lipo archs before thinning (${targetArch}): ${beforeArchs.join(', ')}`);

  if (!beforeArchs.includes(lipoArch)) {
    throw new Error(
      `Downloaded mac binary ${exePath} does not contain target architecture ${lipoArch}. Found: ${beforeArchs.join(', ')}`,
    );
  }

  if (beforeArchs.length === 1) {
    console.log(`[Mac] Skip thinning (${targetArch}) because binary is already single-arch: ${beforeArchs[0]}`);
    fs.chmodSync(exePath, 0o755);
    return;
  }

  const tempPath = `${exePath}.${lipoArch}.thin`;
  execFileSync('lipo', ['-thin', lipoArch, exePath, '-output', tempPath], { stdio: 'inherit' });
  fs.renameSync(tempPath, exePath);
  fs.chmodSync(exePath, 0o755);

  const afterInfo = execFileSync('lipo', ['-info', exePath], { encoding: 'utf8' }).trim();
  const afterArchs = getMacBinaryArchs(exePath);
  console.log(`[Mac] lipo info after thinning (${targetArch}): ${afterInfo}`);
  console.log(`[Mac] lipo archs after thinning (${targetArch}): ${afterArchs.join(', ')}`);
}

async function download(urlStr, dest) {
  if (fs.existsSync(dest)) {
    console.log(`[Cache] Already downloaded: ${path.basename(dest)}`);
    return dest;
  }
  console.log(`Downloading ${urlStr}...`);
  try {
    // We use curl, which automatically respects http_proxy/https_proxy env variables.
    execSync(`curl -L -o "${dest}" "${urlStr}"`, { stdio: 'inherit' });
    return dest;
  } catch (e) {
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    throw e;
  }
}

async function main() {
  if (!fs.existsSync(EXTRA_DIR)) {
    fs.mkdirSync(EXTRA_DIR, { recursive: true });
  }
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  let datExtracted = false;

  for (const target of TARGETS) {
    const zipPath = path.join(CACHE_DIR, target.file);
    const url = `${BASE_URL}${target.file}`;

    try {
      await download(url, zipPath);

      const zip = new AdmZip(zipPath);
      const targetDir = path.join(EXTRA_DIR, target.os, target.arch);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      // Extract specific files
      const zipEntries = zip.getEntries();
      for (const entry of zipEntries) {
        if (entry.entryName === 'xray.exe' || entry.entryName === 'xray') {
          zip.extractEntryTo(entry, targetDir, false, true);
          const exePath = path.join(targetDir, entry.entryName);
          if (target.os !== 'win') {
            fs.chmodSync(exePath, 0o755); // Make executable on mac/linux
          }
          if (target.os === 'mac') {
            // 某些上游 macOS 产物可能已经是 fat/universal Mach-O。
            // 也可能已经是目标架构的 thin Mach-O。
            // electron-builder 在制作 universal App 时会再次对 extraResources 中
            // 的 Mach-O 执行 lipo；因此这里只在上游产物为 fat/universal 时
            // 才裁剪到目标架构，若本身已是目标单架构则直接复用。
            thinMacBinary(exePath, target.arch);
          }
          console.log(`Extracted ${entry.entryName} to ${target.os}/${target.arch}`);
        } else if (!datExtracted && (entry.entryName === 'geoip.dat' || entry.entryName === 'geosite.dat')) {
          zip.extractEntryTo(entry, EXTRA_DIR, false, true);
          console.log(`Extracted ${entry.entryName} to extra/xray/`);
        }
      }
      datExtracted = true; // Only extract .dat files once
    } catch (e) {
      console.error(`Error processing ${target.file}:`, e);
      process.exit(1);
    }
  }
  console.log('All Xray binaries downloaded and extracted successfully.');
}

main();