const http = require('http');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function execFileText(file, args, timeout = 8000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr }));
      else resolve(String(stdout || '').trim());
    });
  });
}

function getText(url, timeout = 3500, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('页面跳转次数过多'));
    const request = http.get(url, { timeout, headers: { 'User-Agent': 'AX3600-ImmortalWrt-Assistant/1.0' } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return resolve(getText(new URL(response.headers.location, url).toString(), timeout, redirects + 1));
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        if (body.length < 512 * 1024) body += chunk;
      });
      response.on('end', () => resolve({ status: response.statusCode || 0, body }));
    });
    request.on('timeout', () => request.destroy(new Error('连接超时')));
    request.on('error', reject);
  });
}

async function defaultGateway() {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$r=Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | Where-Object {$_.NextHop -ne '0.0.0.0'} | Sort-Object RouteMetric,InterfaceMetric | Select-Object -First 1",
    "if($r){$r.NextHop}",
  ].join(';');
  try {
    return await execFileText(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script]);
  } catch {
    try {
      const routeExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'route.exe');
      const table = await execFileText(routeExe, ['PRINT', '-4']);
      return table.match(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d{1,3}(?:\.\d{1,3}){3})\s+/m)?.[1] || '';
    } catch {
      return '';
    }
  }
}

function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function networkSummary() {
  const rows = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family === 'IPv4' && !item.internal) rows.push({ name, address: item.address, netmask: item.netmask });
    }
  }
  return rows;
}

function isAx3600Identity(...values) {
  const identity = values.map((value) => String(value || '')).join(' ');
  return /(?:^|[^a-z0-9])(?:r3600|ra70|ax3600)(?:[^a-z0-9]|$)|xiaomi\.router\.ra70/i.test(identity);
}

async function detectRouter() {
  const gateway = await defaultGateway();
  const base = {
    detectedAt: new Date().toISOString(),
    gateway: gateway || '未发现',
    adapters: networkSummary(),
    state: 'not-found',
    label: '未发现设备',
    model: '尚未识别',
    system: '未知',
    version: '—',
    headline: '请连接 AX3600 LAN 口',
    next: '连接网线并保持路由器开机，软件会自动重新检测。',
    safeToFlash: false,
  };

  const candidates = [...new Set([gateway, '192.168.31.1', '192.168.1.1', '192.168.8.1'].filter(Boolean))];
  for (const ip of candidates) {
    if (ip === '192.168.31.1') {
      for (const endpoint of ['/cgi-bin/luci/api/xqsystem/init_info', '/api/xqsystem/init_info']) {
        try {
          const response = await getText(`http://${ip}${endpoint}`);
          const data = parseJsonLoose(response.body);
          const raw = response.body.toLowerCase();
          const hardware = String(data?.hardware || data?.code === 0 && data?.hardware || '');
          const version = String(data?.romversion || data?.romVersion || data?.version || (raw.includes('1.0.17') ? '1.0.17' : '未知'));
          // Xiaomi's stock API reports AX3600 as R3600 on some firmware versions.
          const isAx3600 = isAx3600Identity(hardware, data?.model, raw);
          if (isAx3600) {
            const ready = version.includes('1.0.17');
            return {
              ...base, gateway: ip, state: ready ? 'stock-ready' : 'stock-downgrade',
              label: ready ? '原厂可安装' : '需要准备原厂版本', model: 'Xiaomi AX3600 / RA70',
              system: '小米原厂', version, safeToFlash: ready,
              headline: ready ? '设备已确认，可以安装 ImmortalWrt' : '设备正确，需要先准备官方 1.0.17',
              next: ready ? '点击“安装 ImmortalWrt”，其余检查、备份和等待均由软件完成。' : '点击主按钮准备官方原厂包，安装并重启后软件会自动识别。',
            };
          }
          if (data || raw.includes('xiaomi')) {
            return { ...base, gateway: ip, state: 'wrong', label: '设备不匹配', model: hardware || '其他小米路由器', system: '小米原厂', version, headline: '不是 AX3600，已禁止安装', next: '本软件只支持 Xiaomi AX3600 / RA70。' };
          }
        } catch { /* Try next endpoint. */ }
      }
    }

    for (const endpoint of ['/', '/cgi-bin/luci/']) {
      try {
        const response = await getText(`http://${ip}${endpoint}`);
        const raw = response.body.toLowerCase();
        if (/中国联通智能网关|login_cu\.js|cu\.html/.test(response.body)) {
          return { ...base, gateway: ip, state: 'gateway-conflict', label: '当前连接到光猫', model: '中国联通智能网关', system: '光猫后台', version: '—', headline: '当前设备不是 AX3600', next: '电脑现在连到光猫。请把网线直接插入 AX3600 的 LAN 口，并暂时拔掉 AX3600 的 WAN 网线后重新检测。' };
        }
        if (raw.includes('immortalwrt')) {
          return { ...base, gateway: ip, state: 'immortalwrt', label: '系统已就绪', model: 'Xiaomi AX3600（已安装）', system: 'ImmortalWrt', version: '25.12.2', headline: 'ImmortalWrt 已运行，可以开始使用', next: '可打开网络、Wi-Fi 和系统管理页面；安装时创建的安全备份也可以直接查看。' };
        }
        if (raw.includes('openwrt') || raw.includes('luci')) {
          return { ...base, gateway: ip, state: 'openwrt-unverified', label: '发现路由系统', model: 'OpenWrt 设备（未验证）', system: 'OpenWrt 类系统', version: '未知', headline: '发现路由系统，需要确认是否为 AX3600', next: '先直接连接 AX3600 LAN 口；确认型号前不会执行写入。' };
        }
      } catch { /* Continue scanning. */ }
    }
  }
  return base;
}

module.exports = { detectRouter, execFileText, getText, isAx3600Identity, POWERSHELL };
