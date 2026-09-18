const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { Client } = require('ssh2');
const { app, shell } = require('electron');
const { detectRouter, execFileText, POWERSHELL } = require('./detection.cjs');
const { runFlash } = require('./flash.cjs');

const OEM_FILE_NAME = 'miwifi_r3600_firmware_5da25_1.0.17.bin';
const OEM_SHA256 = 'dfbe347339903f2ae348be2e4b6434cc77dfd2247d970d7be7b3eac76731dd40';

const definitions = {
  detect: ['检查电脑网络', '读取默认网关', '识别设备型号', '确认当前系统'],
  prepare_oem: ['检查官方资源', '下载原厂 1.0.17', '校验 SHA256', '打开保存位置'],
  install_oem: ['确认原厂包已准备', '打开小米路由器后台', '选择 BIN 固件并安装', '重启后重新检测'],
  flash: ['确认 AX3600 身份', '校验固件资源', '创建安全备份', '启动临时系统', '安装永久系统', '重启并验证'],
  network: ['验证 AX3600 与管理密码', '设置 WAN 上网方式', '设置或跳过 Wi-Fi', '应用并重启网络'],
  backup: ['读取设备指纹', '备份关键分区', '校验本地副本', '生成恢复清单'],
  repair: ['检查路由器连接', '检查 WAN 与 DHCP', '检查 DNS 与防火墙', '整理修复建议'],
};

function appRoot() {
  return path.join(app.getPath('documents'), 'AX3600 ImmortalWrt 助手');
}

function ensureFolders() {
  const root = appRoot();
  for (const name of ['backups', 'logs', 'firmware_cache', 'recovery']) fs.mkdirSync(path.join(root, name), { recursive: true });
  return root;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function writeLog(message, data = null) {
  const root = ensureFolders();
  const line = `${new Date().toISOString()} ${message}${data ? ` ${JSON.stringify(data)}` : ''}\n`;
  fs.appendFileSync(path.join(root, 'logs', 'assistant.log'), line, 'utf8');
}

function emit(sender, action, index, total, status, message, percent) {
  sender.send('action:progress', { action, index, total, status, message, percent });
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function connectSsh(host, password, timeout = 25000) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const timer = setTimeout(() => {
      client.end();
      reject(new Error('连接 ImmortalWrt 超时，请确认电脑已连接 AX3600 LAN 口。'));
    }, timeout);
    client.once('ready', () => {
      clearTimeout(timer);
      resolve(client);
    });
    client.once('error', (error) => {
      clearTimeout(timer);
      reject(new Error(/authentication|password/i.test(error.message) ? 'ImmortalWrt 管理密码不正确。' : `无法连接 ImmortalWrt：${error.message}`));
    });
    client.connect({ host, port: 22, username: 'root', password, readyTimeout: timeout, keepaliveInterval: 5000 });
  });
}

function sshExec(client, command, timeout = 30000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('路由器执行设置超时。'));
      }
    }, timeout);
    client.exec(command, (error, stream) => {
      if (error) {
        clearTimeout(timer);
        return reject(error);
      }
      let stdout = '';
      let stderr = '';
      stream.on('data', (chunk) => { stdout += chunk.toString(); });
      stream.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      stream.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: Number(code || 0), stdout, stderr });
      });
    });
  });
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(file);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function downloadFile(url, destination, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('下载重定向次数过多'));
    const request = https.get(url, { headers: { 'User-Agent': 'AX3600-ImmortalWrt-Assistant/1.0' } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, url).toString();
        return resolve(downloadFile(next, destination, onProgress, redirects + 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`官方下载失败（HTTP ${response.statusCode}）`));
      }
      const total = Number(response.headers['content-length'] || 0);
      let received = 0;
      const output = fs.createWriteStream(destination, { flags: 'wx' });
      response.on('data', (chunk) => { received += chunk.length; if (onProgress) onProgress(received, total); });
      response.pipe(output);
      output.on('finish', () => output.close(resolve));
      output.on('error', reject);
    });
    request.setTimeout(30000, () => request.destroy(new Error('下载连接超时')));
    request.on('error', reject);
  });
}

async function resourceStatus(resourceDir) {
  const manifestPath = path.join(resourceDir, 'firmware-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const checks = [];
  for (const item of manifest.files) {
    const file = path.join(resourceDir, item.fileName);
    if (!fs.existsSync(file)) {
      checks.push({ ...item, present: false, valid: false });
      continue;
    }
    const actual = await sha256(file);
    checks.push({ ...item, present: true, actualSha256: actual, valid: Boolean(item.sha256) && actual.toLowerCase() === item.sha256.toLowerCase() });
  }
  return { releaseReady: manifest.releaseReady === true && checks.every((item) => item.valid), checks };
}

async function oemPackageStatus() {
  const folder = path.join(ensureFolders(), 'recovery');
  const file = path.join(folder, OEM_FILE_NAME);
  const ready = fs.existsSync(file) && await sha256(file) === OEM_SHA256;
  return { ready, folder, file };
}

async function runAction(sender, action, payload, resourceDir) {
  const steps = definitions[action];
  if (!steps) throw new Error('未知功能');
  writeLog(`开始：${action}`);

  if (action === 'detect') {
    emit(sender, action, 0, steps.length, 'running', steps[0], 8);
    const result = await detectRouter();
    for (let i = 1; i < steps.length; i += 1) {
      emit(sender, action, i, steps.length, 'running', steps[i], Math.round(((i + 0.5) / steps.length) * 100));
      await delay(160);
    }
    emit(sender, action, steps.length, steps.length, 'success', '检测完成', 100);
    writeLog('检测完成', { state: result.state, gateway: result.gateway });
    return { ok: true, kind: 'detect', device: result, title: '检测完成', message: result.next };
  }

  if (action === 'flash') {
    const device = await detectRouter();
    emit(sender, action, 0, steps.length, 'running', steps[0], 6);
    if (device.state !== 'stock-ready') {
      const reason = device.state === 'stock-downgrade' ? '当前原厂版本不是 1.0.17，请先使用主按钮准备原厂版本。' : '没有确认当前设备是 AX3600 原厂 1.0.17。';
      emit(sender, action, 0, steps.length, 'error', reason, 6);
      writeLog('安装被安全锁阻止', { state: device.state });
      return { ok: false, safe: true, title: '已安全停止', message: reason };
    }
    emit(sender, action, 1, steps.length, 'running', steps[1], 15);
    const resources = await resourceStatus(resourceDir);
    if (!resources.releaseReady) {
      emit(sender, action, 1, steps.length, 'error', '正式固件尚未通过发布校验', 15);
      writeLog('安装被资源锁阻止', resources.checks.map(({ role, present, valid }) => ({ role, present, valid })));
      return {
        ok: false,
        safe: true,
        title: '正式固件尚未就绪',
        message: 'ImmortalWrt 官方固件文件缺失或校验失败，真实写入保持锁定。路由器没有被修改。',
        details: resources.checks,
      };
    }
    const byRole = Object.fromEntries(resources.checks.map((item) => [item.role, { path: path.join(resourceDir, item.fileName), sha256: item.sha256 }]));
    const root = ensureFolders();
    const sessionDir = path.join(root, 'backups', timestamp());
    try {
      return await runFlash({
        sender,
        payload,
        files: byRole,
        sessionDir,
        emit: (index, message, percent) => emit(sender, action, index, steps.length, 'running', message, percent),
        log: writeLog,
      });
    } catch (error) {
      writeLog('刷机流程停止', { message: String(error.message || error).slice(0, 1600), sessionDir });
      throw error;
    }
  }

  if (action === 'prepare_oem') {
    const root = ensureFolders();
    const target = path.join(root, 'recovery');
    const fileName = OEM_FILE_NAME;
    const expected = OEM_SHA256;
    const finalFile = path.join(target, fileName);
    const tempFile = `${finalFile}.download`;
    emit(sender, action, 0, steps.length, 'running', steps[0], 6);
    let valid = fs.existsSync(finalFile) && await sha256(finalFile) === expected;
    if (!valid) {
      try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch { /* Temporary file only. */ }
      emit(sender, action, 1, steps.length, 'running', steps[1], 18);
      try {
        await downloadFile(
          'https://cdn.cnbj1.fds.api.mi-img.com/xiaoqiang/rom/r3600/miwifi_r3600_firmware_5da25_1.0.17.bin',
          tempFile,
          (received, total) => emit(sender, action, 1, steps.length, 'running', total ? `正在下载官方原厂包（${Math.round(received / total * 100)}%）` : '正在下载官方原厂包', total ? 18 + Math.round(received / total * 48) : 35),
        );
        emit(sender, action, 2, steps.length, 'running', steps[2], 72);
        valid = await sha256(tempFile) === expected;
        if (!valid) throw new Error('官方原厂包 SHA256 不匹配，文件已拒绝使用。');
        if (fs.existsSync(finalFile)) fs.unlinkSync(finalFile);
        fs.renameSync(tempFile, finalFile);
      } catch (error) {
        try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch { /* Temporary file only. */ }
        throw error;
      }
    }
    emit(sender, action, 3, steps.length, 'running', steps[3], 94);
    fs.copyFileSync(finalFile, path.join(target, 'C0A81F02.img'));
    await shell.openPath(target);
    emit(sender, action, steps.length, steps.length, 'success', '官方原厂包已校验', 100);
    writeLog('官方 1.0.17 已准备并通过 SHA256 校验');
    return { ok: true, title: '官方 1.0.17 已准备', message: `文件已经通过固定 SHA256 校验，同时生成了 TFTP 恢复文件 C0A81F02.img。\n保存位置：${target}` };
  }

  if (action === 'install_oem') {
    const status = await oemPackageStatus();
    if (!status.ready) return { ok: false, safe: true, title: '原厂包尚未准备好', message: '请先下载并校验官方 1.0.17。' };
    const device = await detectRouter();
    if (device.state !== 'stock-downgrade') return { ok: false, safe: true, title: '当前状态不适用', message: '没有确认当前连接的是需要降级的 AX3600 原厂系统。' };
    emit(sender, action, 0, steps.length, 'running', steps[0], 20);
    await shell.openPath(status.folder);
    emit(sender, action, 1, steps.length, 'running', steps[1], 55);
    await shell.openExternal(`http://${device.gateway}/`);
    emit(sender, action, steps.length, steps.length, 'warning', '请在小米后台完成手动升级', 100);
    writeLog('已打开原厂 1.0.17 手动安装引导', { gateway: device.gateway });
    return {
      ok: true,
      warning: true,
      title: '下一步：在小米后台安装 1.0.17',
      message: `请进入“常用设置 → 系统状态 → 手动升级”，选择 ${OEM_FILE_NAME}。\n不要选择 C0A81F02.img，它只用于断电恢复。\n安装重启完成后回到本软件，点击“重新检测”。`,
    };
  }

  if (action === 'network') {
    const device = await detectRouter();
    if (device.state !== 'immortalwrt') return { ok: false, safe: true, title: device.state === 'gateway-conflict' ? '当前连接的是光猫' : '尚未连接 AX3600', message: device.next || '请把电脑网线直接连接 AX3600 LAN 口后重新检测。' };
    const mode = payload.wanMode === 'pppoe' ? 'pppoe' : 'dhcp';
    const adminPassword = String(payload.adminPassword || '');
    const pppoeUser = String(payload.pppoeUser || '').trim();
    const pppoePassword = String(payload.pppoePassword || '');
    const configureWifi = payload.configureWifi === true;
    const wifiSsid = String(payload.wifiSsid || '').trim();
    const wifiPassword = String(payload.wifiPassword || '');
    const lanMode = ['keep', 'change'].includes(payload.lanMode) ? payload.lanMode : 'auto';
    if (!adminPassword) return { ok: false, safe: true, title: '请输入管理密码', message: '请输入刷机时设置的 ImmortalWrt 管理密码。' };
    if (mode === 'pppoe' && (!pppoeUser || !pppoePassword)) return { ok: false, safe: true, title: '宽带账号未填写完整', message: 'PPPoE 需要填写宽带账号和宽带密码。' };
    if (configureWifi && (Buffer.byteLength(wifiSsid, 'utf8') < 1 || Buffer.byteLength(wifiSsid, 'utf8') > 32)) return { ok: false, safe: true, title: 'Wi-Fi 名称不合适', message: 'Wi-Fi 名称应为 1–32 个字节。' };
    if (configureWifi && (wifiPassword.length < 8 || wifiPassword.length > 63)) return { ok: false, safe: true, title: 'Wi-Fi 密码不合适', message: 'Wi-Fi 密码应为 8–63 位。' };

    let client;
    try {
      emit(sender, action, 0, steps.length, 'running', steps[0], 12);
      client = await connectSsh(device.gateway, adminPassword);
      const identity = await sshExec(client, "ubus call system board; printf '\\n'; tr '\\0' '\\n' </proc/device-tree/compatible 2>/dev/null", 20000);
      if (identity.code !== 0 || !/ImmortalWrt/i.test(identity.stdout) || !/xiaomi,ax3600/i.test(identity.stdout)) throw new Error('设备身份复核失败，未应用任何网络设置。');

      const wanStatus = await sshExec(client, "ubus call network.interface.wan status 2>/dev/null || true", 15000);
      let wanConflict = false;
      try {
        const status = JSON.parse(wanStatus.stdout || '{}');
        const addresses = Array.isArray(status['ipv4-address']) ? status['ipv4-address'].map((item) => String(item?.address || '')) : [];
        const gateways = Array.isArray(status.route) ? status.route.map((item) => String(item?.nexthop || '')) : [];
        wanConflict = addresses.some((address) => /^192\.168\.1\./.test(address)) || gateways.includes('192.168.1.1');
      } catch {
        wanConflict = /"address"\s*:\s*"192\.168\.1\.\d+"|"nexthop"\s*:\s*"192\.168\.1\.1"/.test(wanStatus.stdout || '');
      }
      const changeLan = lanMode === 'change' || (lanMode === 'auto' && mode === 'dhcp' && wanConflict);

      const commands = [];
      const lanDecision = changeLan ? (lanMode === 'auto' ? '检测到同网段冲突，将改为 192.168.8.1' : '将管理地址改为 192.168.8.1') : '未确认地址冲突，保持当前管理地址';
      emit(sender, action, 1, steps.length, 'running', `${mode === 'dhcp' ? '正在设置自动获取 DHCP' : '正在设置宽带拨号 PPPoE'}；${lanDecision}`, 34);
      commands.push(`uci set network.wan.proto=${shellQuote(mode)}`);
      if (mode === 'pppoe') {
        commands.push(`uci set network.wan.username=${shellQuote(pppoeUser)}`);
        commands.push(`uci set network.wan.password=${shellQuote(pppoePassword)}`);
      } else {
        commands.push('uci -q delete network.wan.username || true');
        commands.push('uci -q delete network.wan.password || true');
      }
      if (changeLan) {
        commands.push("uci set network.lan.ipaddr='192.168.8.1'");
        commands.push("uci set network.lan.netmask='255.255.255.0'");
      }
      commands.push('uci commit network');

      emit(sender, action, 2, steps.length, 'running', configureWifi ? '正在设置 Wi-Fi' : '已跳过 Wi-Fi 设置', 62);
      if (configureWifi) {
        commands.push(`sections=\"$(uci show wireless | sed -n \"s/^wireless\\.\\([^.=]*\\)=wifi-iface$/\\1/p\" | head -n 2)\"`);
        commands.push('[ -n "$sections" ] || { echo AX_NO_WIFI; exit 41; }');
        commands.push(`for section in $sections; do uci set wireless.$section.disabled='0'; uci set wireless.$section.ssid=${shellQuote(wifiSsid)}; uci set wireless.$section.encryption='psk2'; uci set wireless.$section.key=${shellQuote(wifiPassword)}; done`);
        commands.push('uci commit wireless');
      }
      commands.push("(sleep 2; /etc/init.d/network restart; wifi reload 2>/dev/null || true) >/tmp/ax3600-network-apply.log 2>&1 &");
      commands.push('echo AX_NETWORK_ACCEPTED');

      emit(sender, action, 3, steps.length, 'running', '正在保存设置并重启网络', 84);
      const applied = await sshExec(client, commands.join('; '), 30000);
      if (applied.code !== 0 || !applied.stdout.includes('AX_NETWORK_ACCEPTED')) throw new Error(applied.stdout.includes('AX_NO_WIFI') ? '没有找到可配置的 Wi-Fi，请选择跳过后重试。' : `应用网络设置失败：${applied.stderr || applied.stdout || '路由器未接受命令'}`);
      emit(sender, action, steps.length, steps.length, 'success', '网络设置已保存', 100);
      writeLog('网络向导完成', { gateway: device.gateway, wanMode: mode, wifiConfigured: configureWifi, lanMode, wanConflict, lanAddressChanged: changeLan });
      const address = changeLan ? '192.168.8.1' : device.gateway;
      const addressResult = changeLan ? `${lanMode === 'auto' ? '检测到 WAN/LAN 同网段冲突，已自动调整' : '已按你的选择调整'}管理地址：http://${address}` : `未确认存在 WAN/LAN 同网段冲突，已保持管理地址：http://${address}`;
      return { ok: true, title: '网络设置已完成', message: `路由器正在重启网络，请等待约 1 分钟。\n${addressResult}\n${configureWifi ? `Wi-Fi 名称：${wifiSsid}` : 'Wi-Fi 设置已跳过，可稍后再次运行本向导。'}` };
    } finally {
      try { client?.end(); } catch { /* Connection may close during network restart. */ }
    }
  }

  if (action === 'repair') {
    for (let i = 0; i < steps.length; i += 1) {
      emit(sender, action, i, steps.length, 'running', steps[i], Math.round(((i + 0.5) / steps.length) * 100));
      await delay(180);
    }
    const device = await detectRouter();
    const connected = device.state === 'immortalwrt';
    emit(sender, action, steps.length, steps.length, connected ? 'success' : 'warning', connected ? 'AX3600 连接正常' : '已找到连接问题', 100);
    writeLog('连接检查完成', { state: device.state, gateway: device.gateway });
    return {
      ok: true,
      warning: !connected,
      kind: 'detect',
      device,
      title: connected ? 'AX3600 连接正常' : device.state === 'gateway-conflict' ? '电脑当前连接到光猫' : '尚未连接到 AX3600',
      message: device.state === 'gateway-conflict'
        ? '请按顺序操作：1. 暂时拔掉 AX3600 的 WAN 网线；2. 电脑网线插入 AX3600 LAN 口；3. 关闭电脑 Wi-Fi；4. 点击重新检测。进入 ImmortalWrt 后，建议把 AX3600 LAN 地址改成 192.168.8.1，再接回光猫。'
        : device.next,
    };
  }

  if (action === 'backup') {
    const folder = path.join(ensureFolders(), 'backups');
    await shell.openPath(folder);
    emit(sender, action, steps.length, steps.length, 'success', '安全备份已打开', 100);
    return { ok: true, title: '安全备份目录已打开', message: '这里保存了刷机前自动读取并校验的关键分区、备份清单和恢复计划。' };
  }

  for (let i = 0; i < steps.length; i += 1) {
    emit(sender, action, i, steps.length, 'running', steps[i], Math.round(((i + 0.35) / steps.length) * 100));
    await delay(320);
    emit(sender, action, i, steps.length, 'complete', steps[i], Math.round(((i + 1) / steps.length) * 100));
  }

  emit(sender, action, steps.length, steps.length, 'success', '已完成', 100);
  writeLog(`完成：${action}`, payload);
  return { ok: true, title: '操作完成', message: '检查已经完成。真实设备操作只会在设备身份和资源校验全部通过后执行。' };
}

async function openFolder(kind) {
  const root = ensureFolders();
  const allowed = { root, backups: path.join(root, 'backups'), logs: path.join(root, 'logs'), recovery: path.join(root, 'recovery') };
  const target = allowed[kind] || root;
  fs.mkdirSync(target, { recursive: true });
  return shell.openPath(target);
}

module.exports = { runAction, openFolder, resourceStatus, oemPackageStatus, ensureFolders, execFileText, POWERSHELL };
