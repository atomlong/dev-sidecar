const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const AdmZip = require('adm-zip');

const VERSION = '26.2.6';
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