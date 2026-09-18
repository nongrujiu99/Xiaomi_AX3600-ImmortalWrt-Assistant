const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const VERSION = '25.12.2';
const BASE = `https://downloads.immortalwrt.org/releases/${VERSION}/targets/qualcommax/ipq807x`;
const destination = path.resolve(__dirname, '..', 'resources');
const files = [
  {
    role: 'initramfs',
    fileName: `immortalwrt-${VERSION}-qualcommax-ipq807x-xiaomi_ax3600-initramfs-factory.ubi`,
    sha256: 'be4fa6fdfe0520afc42da7c3494db077f23dad9bc017304a8ee20f2484618a81',
  },
  {
    role: 'sysupgrade',
    fileName: `immortalwrt-${VERSION}-qualcommax-ipq807x-xiaomi_ax3600-squashfs-sysupgrade.bin`,
    sha256: '3ad3f437706853ea797cc77b9ddb2c5a26d20e9a03e40ee87fde411091fbb6b0',
  },
];

function digest(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(file);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function download(url, output, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('下载重定向次数过多'));
    const request = https.get(url, { headers: { 'User-Agent': 'AX3600-ImmortalWrt-Assistant/1.0' } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return resolve(download(new URL(response.headers.location, url).toString(), output, redirects + 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`下载失败：HTTP ${response.statusCode}`));
      }
      const temp = `${output}.download`;
      const stream = fs.createWriteStream(temp, { flags: 'w' });
      response.pipe(stream);
      stream.on('error', reject);
      stream.on('finish', () => stream.close(() => {
        fs.renameSync(temp, output);
        resolve();
      }));
    });
    request.setTimeout(60000, () => request.destroy(new Error('下载连接超时')));
    request.on('error', reject);
  });
}

(async () => {
  fs.mkdirSync(destination, { recursive: true });
  for (const item of files) {
    const output = path.join(destination, item.fileName);
    let actual = fs.existsSync(output) ? await digest(output) : '';
    if (actual !== item.sha256) {
      if (fs.existsSync(output)) fs.unlinkSync(output);
      console.log(`下载 ${item.fileName}`);
      await download(`${BASE}/${item.fileName}`, output);
      actual = await digest(output);
    }
    if (actual !== item.sha256) {
      fs.unlinkSync(output);
      throw new Error(`${item.fileName} SHA256 不匹配，文件已删除`);
    }
    item.size = fs.statSync(output).size;
    console.log(`校验通过 ${item.role}: ${actual}`);
  }
  const manifest = {
    product: 'ImmortalWrt',
    version: VERSION,
    device: 'xiaomi_ax3600',
    source: BASE,
    releaseReady: true,
    hardwareValidated: false,
    files,
  };
  fs.writeFileSync(path.join(destination, 'firmware-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log('官方固件与清单已准备完成。');
})().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
