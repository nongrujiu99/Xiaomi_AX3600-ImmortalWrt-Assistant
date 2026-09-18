const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { dialog, BrowserWindow } = require('electron');
const { Client } = require('ssh2');
const { getText } = require('./detection.cjs');

const ROUTER_STOCK = '192.168.31.1';
const ROUTER_TARGETS = ['192.168.1.1'];

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function run(file, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      const result = { code: typeof error?.code === 'number' ? error.code : error ? 1 : 0, stdout: String(stdout || ''), stderr: String(stderr || '') };
      if (error && error.killed) reject(new Error('命令执行超时'));
      else resolve(result);
    });
  });
}

function parseStok(value) {
  const match = String(value || '').match(/;stok=([^/]+)/i);
  return match && match[1].length > 4 ? match[1] : '';
}

function safePassword(value) {
  return typeof value === 'string' && value.length >= 10 && value.length <= 64 && /^[A-Za-z0-9._!@#%^+=,-]+$/.test(value);
}

function httpGet(url, timeout = 9000) {
  return new Promise((resolve, reject) => {
    const request = require('http').get(url, { timeout, headers: { 'User-Agent': 'AX3600-ImmortalWrt-Assistant/1.0' } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { if (body.length < 64 * 1024) body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode || 0, body }));
    });
    request.on('timeout', () => request.destroy(new Error('请求超时')));
    request.on('error', reject);
  });
}

async function xiaomiCommand(stok, command) {
  const encoded = encodeURIComponent(command).replace(/%20/g, '%20');
  const url = `http://${ROUTER_STOCK}/cgi-bin/luci/;stok=${stok}/api/misystem/set_config_iotdev?bssid=gallifrey&user_id=doctor&ssid=-h%0A${encoded}%0A`;
  const response = await httpGet(url);
  let data = null;
  try { data = JSON.parse(response.body); } catch { /* Invalid or login HTML response. */ }
  return {
    ok: response.status === 200 && Number(data?.code) === 0,
    status: response.status,
    code: data?.code,
    message: String(data?.msg || '').slice(0, 160),
  };
}

function connectWithPassword(ip, password, timeout = 45000) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const timer = setTimeout(() => {
      client.end();
      reject(new Error('一次性密码 SSH 连接超时'));
    }, timeout);
    client.once('ready', () => {
      clearTimeout(timer);
      client.on('error', () => { /* Reported by individual operations. */ });
      resolve(client);
    });
    client.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    client.connect({
      host: ip,
      port: 22,
      username: 'root',
      password,
      readyTimeout: timeout,
      keepaliveInterval: 5000,
      keepaliveCountMax: 3,
      algorithms: {
        kex: { prepend: ['diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1'] },
        serverHostKey: { prepend: ['ssh-rsa'] },
        cipher: { prepend: ['aes128-cbc', '3des-cbc'] },
        hmac: { prepend: ['hmac-sha1', 'hmac-md5'] },
      },
    });
  });
}

function connectWithoutPassword(ip, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { client.end(); } catch { /* Best effort only. */ }
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error('临时系统 SSH 连接超时')), timeout);
    client.once('ready', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.on('error', () => { /* Reported by individual operations. */ });
      resolve(client);
    });
    client.once('error', fail);
    client.on('keyboard-interactive', (name, instructions, language, prompts, finish) => finish(prompts.map(() => '')));
    client.connect({
      host: ip,
      port: 22,
      username: 'root',
      password: '',
      tryKeyboard: true,
      readyTimeout: timeout,
      keepaliveInterval: 5000,
      keepaliveCountMax: 3,
      algorithms: {
        kex: { prepend: ['diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1'] },
        serverHostKey: { prepend: ['ssh-rsa'] },
      },
    });
  });
}

function passwordExec(client, command, timeout = 30000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('路由器命令执行超时')); }
    }, timeout);
    client.exec(command, (error, stream) => {
      if (error) {
        clearTimeout(timer);
        if (!settled) { settled = true; reject(error); }
        return;
      }
      let stdout = '';
      let stderr = '';
      stream.on('data', (chunk) => { if (stdout.length < 8 * 1024 * 1024) stdout += chunk.toString('utf8'); });
      stream.stderr.on('data', (chunk) => { if (stderr.length < 2 * 1024 * 1024) stderr += chunk.toString('utf8'); });
      stream.on('close', (code) => {
        clearTimeout(timer);
        if (!settled) { settled = true; resolve({ code: Number(code || 0), stdout, stderr }); }
      });
    });
  });
}

function passwordTransfer(client, source, destination, upload, timeout = 180000, onProgress = null) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stream = null;
    const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
    const finish = (error, result = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      try { stream?.close(); } catch { /* Best effort only. */ }
      finish(new Error('文件传输超时'));
    }, timeout);
    const command = upload ? `cat > ${quote(destination)} && sync && echo AX_UPLOAD_OK` : `cat ${quote(source)}`;
    client.exec(command, (error, channel) => {
      if (error) {
        finish(error);
        return;
      }
      stream = channel;
      let stderr = '';
      let stdout = '';
      channel.stderr.on('data', (chunk) => { if (stderr.length < 8192) stderr += chunk.toString('utf8'); });
      if (upload) {
        const input = fs.createReadStream(source);
        const total = fs.statSync(source).size;
        let transferred = 0;
        channel.on('data', (chunk) => {
          if (stdout.length < 8192) stdout += chunk.toString('utf8');
          if (stdout.includes('AX_UPLOAD_OK')) finish(null, { code: 0, stdout, stderr: '' });
        });
        input.on('data', (chunk) => {
          transferred += chunk.length;
          if (onProgress) onProgress(transferred, total);
        });
        input.once('error', (inputError) => finish(inputError));
        channel.once('error', (channelError) => finish(channelError));
        channel.once('close', (code) => {
          if (Number(code || 0) !== 0) finish(new Error(stderr || `路由器接收文件失败，退出码 ${code}`));
          else finish(null, { code: 0, stdout: '', stderr: '' });
        });
        input.pipe(channel);
      } else {
        const output = fs.createWriteStream(destination, { flags: 'w' });
        let exitCode = null;
        let outputFinished = false;
        const maybeFinish = () => {
          if (exitCode === null || !outputFinished) return;
          if (exitCode !== 0) finish(new Error(stderr || `路由器发送文件失败，退出码 ${exitCode}`));
          else finish(null, { code: 0, stdout: '', stderr: '' });
        };
        output.once('error', (outputError) => finish(outputError));
        output.once('finish', () => { outputFinished = true; maybeFinish(); });
        channel.once('error', (channelError) => finish(channelError));
        channel.once('close', (code) => { exitCode = Number(code || 0); maybeFinish(); });
        channel.pipe(output);
      }
    });
  });
}

function passwordRemoteDigest(client, remote, timeout = 900000, onProgress = null) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stream = null;
    let received = 0;
    let stderr = '';
    const hash = crypto.createHash('sha256');
    const finish = (error, result = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      try { stream?.close(); } catch { /* Best effort only. */ }
      finish(new Error('回读校验超时'));
    }, timeout);
    client.exec(`cat '${remote}'`, (error, channel) => {
      if (error) return finish(error);
      stream = channel;
      channel.on('data', (chunk) => {
        received += chunk.length;
        hash.update(chunk);
        if (onProgress) onProgress(received);
      });
      channel.stderr.on('data', (chunk) => { if (stderr.length < 8192) stderr += chunk.toString('utf8'); });
      channel.once('error', (channelError) => finish(channelError));
      channel.once('close', (code) => {
        if (Number(code || 0) !== 0) finish(new Error(stderr || `路由器回读文件失败，退出码 ${code}`));
        else finish(null, { size: received, sha256: hash.digest('hex') });
      });
    });
  });
}

function parseMtd(text) {
  const parts = new Map();
  const expression = /^mtd(\d+):\s+([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+"([^"]+)"/gm;
  for (const match of text.matchAll(expression)) parts.set(match[4], { index: Number(match[1]), size: Number.parseInt(match[2], 16), erase: Number.parseInt(match[3], 16) });
  return parts;
}

function randomPassword() {
  return crypto.randomBytes(18).toString('base64url').replace(/-/g, 'A').replace(/_/g, 'B').slice(0, 18);
}

async function renewDhcp() {
  const ipconfig = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'ipconfig.exe');
  try { await run(ipconfig, ['/renew'], 45000); } catch { /* Detection continues without it. */ }
}

async function findRouter(candidates, seconds, onTick) {
  for (let elapsed = 0; elapsed < seconds; elapsed += 1) {
    for (const ip of candidates) {
      try {
        const response = await getText(`http://${ip}/`, 1600);
        if (response.status > 0) return ip;
      } catch { /* Try the next address. */ }
    }
    if (elapsed === 8 || (elapsed > 8 && elapsed % 35 === 0)) await renewDhcp();
    if (onTick && elapsed % 5 === 0) onTick(elapsed, seconds);
    await delay(1000);
  }
  return '';
}

async function connectTarget(ip, attempts, onAttempt) {
  let lastError = null;
  for (let index = 0; index < attempts; index += 1) {
    try { return await connectWithoutPassword(ip, 12000); } catch (error) {
      lastError = error;
      if (onAttempt) onAttempt(index + 1, attempts);
      await delay(2000);
    }
  }
  throw new Error(`系统网页已响应，但 SSH 尚未就绪。${lastError?.message ? `详细原因：${lastError.message}` : ''}`);
}

async function confirm(sender, title, message, confirmLabel) {
  const parent = BrowserWindow.fromWebContents(sender);
  const result = await dialog.showMessageBox(parent, { type: 'warning', title, message, detail: '继续后请保持路由器供电和网线连接稳定。', buttons: [confirmLabel, '取消'], defaultId: 1, cancelId: 1, noLink: true });
  return result.response === 0;
}

async function bestEffortCleanup(stok) {
  const clean = "if [ -f /etc/dropbear/authorized_keys ]; then sed -i '/ax3600assistant/d' /etc/dropbear/authorized_keys 2>/dev/null || true; fi; rm -f /tmp/ax3600_tool_key; nvram set ssh_en=0; nvram commit; /etc/init.d/dropbear stop >/dev/null 2>&1 || true";
  try { await xiaomiCommand(stok, clean); } catch { /* Best effort only. */ }
}

async function runFlash({ sender, payload, files, sessionDir, emit, log }) {
  const stok = parseStok(payload.stockUrl);
  if (!stok) throw new Error('请先登录小米后台，并粘贴包含 ;stok= 的完整地址。');
  if (!safePassword(payload.adminPassword)) throw new Error('新管理密码需为 10–64 位，只能包含字母、数字和 . _ - ! @ # % ^ + = ,');

  fs.mkdirSync(sessionDir, { recursive: true });
  let stockSsh = false;
  let stockClient = null;
  let targetClient = null;
  let nandStarted = false;
  let recoveryPlan = null;
  try {
    emit(0, '正在建立一次性安全连接', 4);
    const tempPassword = randomPassword();
    const setup = [
      'nvram set bootdelay=3; nvram set boot_wait=on; nvram set ssh_en=1; nvram commit',
      "sed -i '/flg_ssh.*release/ { :a; N; /fi/! ba };/return 0/d' /etc/init.d/dropbear",
      `printf '%s\\n%s\\n' '${tempPassword}' '${tempPassword}' | passwd root`,
      '/etc/init.d/dropbear enable; /etc/init.d/dropbear start',
    ];
    for (let index = 0; index < setup.length; index += 1) {
      const response = await xiaomiCommand(stok, setup[index]);
      if (!response.ok) {
        log('小米命令接口拒绝请求', { stage: index + 1, http: response.status, code: response.code, message: response.message });
        throw new Error(`小米后台没有接受临时 SSH 请求（HTTP ${response.status}${response.code !== undefined ? `，代码 ${response.code}` : ''}）。请重新登录后台并取得新地址。`);
      }
      if (index === 0) stockSsh = true;
      await delay(500);
    }
    let lastSshError = '';
    for (let index = 0; index < 18 && !stockClient; index += 1) {
      try {
        stockClient = await connectWithPassword(ROUTER_STOCK, tempPassword, 12000);
        const test = await passwordExec(stockClient, 'echo AX3600_PASSWORD_OK', 15000);
        if (test.code !== 0 || !test.stdout.includes('AX3600_PASSWORD_OK')) throw new Error(test.stderr || '一次性密码验证失败');
      } catch (error) {
        if (stockClient) { try { stockClient.end(); } catch { /* Retry. */ } stockClient = null; }
        lastSshError = String(error.message || error).trim().slice(0, 600);
        if ((index + 1) % 4 === 0) await xiaomiCommand(stok, '/etc/init.d/dropbear start');
        emit(0, `等待原厂 SSH 就绪（${index + 1}/18）`, 4 + Math.min(4, Math.floor(index / 4)));
        await delay(2000);
      }
    }
    if (!stockClient) {
      log('临时 SSH 认证失败', { error: lastSshError || '没有收到 SSH 错误文本' });
      throw new Error(`一次性密码 SSH 未能连接。${lastSshError ? `详细原因：${lastSshError}` : '请确认原厂版本为 1.0.17。'} 路由器 NAND 没有被写入。`);
    }

    emit(1, '正在复核机型和分区', 12);
    const probeCommand = "cat /usr/share/xiaoqiang/xiaoqiang_version 2>/dev/null; echo __MTD__; cat /proc/mtd; echo __FLAG__; nvram get flag_boot_rootfs; echo __MODEL__; cat /proc/device-tree/model 2>/dev/null";
    const probe = await passwordExec(stockClient, probeCommand, 30000);
    if (probe.code !== 0 || !/R3600|AX3600/i.test(probe.stdout) || !probe.stdout.includes('1.0.17')) throw new Error('路由器内部验证未通过：必须是 R3600 / AX3600 原厂 1.0.17。');
    fs.writeFileSync(path.join(sessionDir, 'stock_probe.txt'), probe.stdout, 'utf8');
    const mtd = parseMtd(probe.stdout);
    const required = ['0:SBL1', '0:MIBIB', '0:APPSBLENV', '0:APPSBL', '0:ART', 'bdata', 'rootfs', 'rootfs_1'];
    if (!required.every((name) => mtd.has(name))) throw new Error('MTD 分区表与 AX3600 预期布局不一致。');
    const root0 = mtd.get('rootfs'); const root1 = mtd.get('rootfs_1');
    if (root0.index !== 12 || root1.index !== 13 || root0.size !== 0x023c0000 || root1.size !== 0x023c0000) throw new Error('双 rootfs 分区编号或大小不一致。');
    const flagText = probe.stdout.split('__FLAG__')[1]?.split('__MODEL__')[0]?.trim() || '';
    const flag = flagText.match(/\b[01]\b/)?.[0];
    if (flag !== '0' && flag !== '1') throw new Error('无法确认当前启动槽。');

    emit(2, '正在备份六个关键分区', 20);
    const names = ['0:SBL1', '0:MIBIB', '0:APPSBLENV', '0:APPSBL', '0:ART', 'bdata'];
    const safeNames = ['SBL1', 'MIBIB', 'APPSBLENV', 'APPSBL', 'ART', 'bdata'];
    const hashes = [];
    for (let index = 0; index < names.length; index += 1) {
      const part = mtd.get(names[index]);
      const remote = `/tmp/ax3600_${safeNames[index]}.bin`;
      const local = path.join(sessionDir, `${safeNames[index]}.bin`);
      const read = await passwordExec(stockClient, `rm -f '${remote}'; dd if=/dev/mtd${part.index} of='${remote}' bs=64k 2>/dev/null; sync`, 90000);
      if (read.code !== 0) throw new Error(`读取关键分区 ${safeNames[index]} 失败。`);
      const copied = await passwordTransfer(stockClient, remote, local, false, 120000);
      if (copied.code !== 0 || fs.statSync(local).size !== part.size) throw new Error(`备份 ${safeNames[index]} 的尺寸校验失败。`);
      const digest = crypto.createHash('sha256').update(fs.readFileSync(local)).digest('hex');
      hashes.push({ name: safeNames[index], size: part.size, sha256: digest });
      emit(2, `已备份 ${safeNames[index]}（${index + 1}/6）`, 20 + Math.round(((index + 1) / 6) * 20));
    }
    fs.writeFileSync(path.join(sessionDir, 'backup-manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), model: 'Xiaomi AX3600 / RA70', partitions: hashes }, null, 2), 'utf8');
    recoveryPlan = {
      createdAt: new Date().toISOString(), model: 'Xiaomi AX3600 / RA70',
      originalBootSlot: Number(flag), temporaryBootSlot: flag === '0' ? 1 : 0,
      stage: 'backup-complete', routerAddresses: [ROUTER_STOCK, ...ROUTER_TARGETS],
      firmware: { initramfsSha256: files.initramfs.sha256, sysupgradeSha256: files.sysupgrade.sha256 },
      backupManifest: path.join(sessionDir, 'backup-manifest.json'),
    };
    fs.writeFileSync(path.join(sessionDir, 'recovery-plan.json'), JSON.stringify(recoveryPlan, null, 2), 'utf8');
    fs.writeFileSync(path.join(sessionDir, '恢复说明.txt'), [
      'AX3600 ImmortalWrt 助手恢复记录',
      '',
      `原启动槽：${flag}`,
      `本次临时系统目标槽：${flag === '0' ? '1' : '0'}`,
      `备份清单：${path.join(sessionDir, 'backup-manifest.json')}`,
      '',
      '如果程序提示“写入后停止”：',
      '1. 保持路由器供电，不要重复点击安装。',
      '2. 先等待 5 分钟，再用“重新检测”。',
      '3. 仍无法发现时，保留本目录和 assistant.log，再进行针对性恢复。',
      '4. 不要自行擦除 ART、bdata、APPSBL 或 MIBIB 分区。',
    ].join('\r\n'), 'utf8');

    emit(3, '正在上传并校验临时系统', 44);
    const initRemote = '/tmp/ax3600-immortalwrt-initramfs.ubi';
    let lastUploadPercent = -1;
    const uploaded = await passwordTransfer(stockClient, files.initramfs.path, initRemote, true, 900000, (sent, total) => {
      const percent = total ? Math.min(100, Math.floor((sent / total) * 100)) : 0;
      if (percent !== lastUploadPercent) {
        lastUploadPercent = percent;
        emit(3, `正在上传临时系统（${percent}%）`, 44 + Math.floor(percent * 0.06));
      }
    });
    if (uploaded.code !== 0) throw new Error('临时系统上传失败。');
    const initSize = fs.statSync(files.initramfs.path).size;
    let lastVerifyPercent = -1;
    const initDigest = await passwordRemoteDigest(stockClient, initRemote, 900000, (received) => {
      const percent = Math.min(100, Math.floor((received / initSize) * 100));
      if (percent !== lastVerifyPercent) {
        lastVerifyPercent = percent;
        emit(3, `正在逐字节回读校验临时系统（${percent}%）`, 50);
      }
    });
    if (initDigest.size !== initSize || initDigest.sha256.toLowerCase() !== files.initramfs.sha256.toLowerCase()) {
      log('临时系统回读校验失败', { expectedSize: initSize, actualSize: initDigest.size, expectedSha256: files.initramfs.sha256, actualSha256: initDigest.sha256 });
      throw new Error(`临时系统传输校验失败（应为 ${initSize} 字节，实际 ${initDigest.size} 字节）。`);
    }
    if (!await confirm(sender, '最后确认：安装临时系统', '设备身份、分区、备份和固件校验均已通过。下一步将第一次写入 NAND。', '确认写入')) throw new Error('你已在写入前取消，路由器 NAND 没有被写入。');

    emit(3, '正在写入未启动槽，请勿断电', 52);
    nandStarted = true;
    recoveryPlan.stage = 'temporary-write-started';
    fs.writeFileSync(path.join(sessionDir, 'recovery-plan.json'), JSON.stringify(recoveryPlan, null, 2), 'utf8');
    const write = flag === '0'
      ? `ubiformat /dev/mtd13 -y -f '${initRemote}' -s 2048 -O 2048 && nvram set flag_boot_rootfs=1 && nvram set flag_last_success=1 && nvram commit && sync`
      : `ubiformat /dev/mtd12 -y -f '${initRemote}' -s 2048 -O 2048 && nvram set flag_boot_rootfs=0 && nvram set flag_last_success=0 && nvram commit && sync`;
    const written = await passwordExec(stockClient, write, 180000);
    if (written.code !== 0) throw new Error('临时系统写入失败。请保持供电并查看日志，不要重复刷写。');
    recoveryPlan.stage = 'temporary-written';
    fs.writeFileSync(path.join(sessionDir, 'recovery-plan.json'), JSON.stringify(recoveryPlan, null, 2), 'utf8');
    await passwordExec(stockClient, "rm -f /etc/dropbear/authorized_keys /root/.ssh/authorized_keys 2>/dev/null || true; nvram set ssh_en=0; nvram commit; sync; reboot", 20000).catch(() => ({ code: 0 }));
    try { stockClient.end(); } catch { /* Router is rebooting. */ }
    stockClient = null;
    stockSsh = false;

    emit(3, '等待临时 ImmortalWrt 启动', 61);
    const targetIp = await findRouter(ROUTER_TARGETS, 240, (elapsed) => emit(3, `正在重新获取网络并寻找临时系统（${elapsed} 秒）`, 61 + Math.min(8, Math.floor(elapsed / 28))));
    if (!targetIp) throw new Error(`临时系统重启后仍未在 ${ROUTER_TARGETS.join(' 或 ')} 响应。请保持供电并打开恢复说明，不要重复刷写。`);
    targetClient = await connectTarget(targetIp, 20, (attempt) => emit(3, `临时系统已发现，等待管理服务（${attempt}/20）`, 68));
    const board = await passwordExec(targetClient, 'ubus call system board; cat /etc/openwrt_release 2>/dev/null', 30000);
    if (board.code !== 0 || !/xiaomi,ax3600|Xiaomi AX3600/i.test(board.stdout)) throw new Error('临时系统机型复核失败。');
    recoveryPlan.stage = 'temporary-running';
    recoveryPlan.temporaryAddress = targetIp;
    fs.writeFileSync(path.join(sessionDir, 'recovery-plan.json'), JSON.stringify(recoveryPlan, null, 2), 'utf8');

    emit(4, '正在上传并检查永久系统', 73);
    const sysRemote = '/tmp/ax3600-immortalwrt-sysupgrade.bin';
    let lastSysPercent = -1;
    const sysUploaded = await passwordTransfer(targetClient, files.sysupgrade.path, sysRemote, true, 900000, (sent, total) => {
      const percent = total ? Math.min(100, Math.floor((sent / total) * 100)) : 0;
      if (percent !== lastSysPercent) {
        lastSysPercent = percent;
        emit(4, `正在上传永久系统（${percent}%）`, 73 + Math.floor(percent * 0.07));
      }
    });
    if (sysUploaded.code !== 0) throw new Error('永久系统上传失败。');
    const sysSize = fs.statSync(files.sysupgrade.path).size;
    let lastSysVerifyPercent = -1;
    const sysDigest = await passwordRemoteDigest(targetClient, sysRemote, 900000, (received) => {
      const percent = Math.min(100, Math.floor((received / sysSize) * 100));
      if (percent !== lastSysVerifyPercent) {
        lastSysVerifyPercent = percent;
        emit(4, `正在逐字节回读校验永久系统（${percent}%）`, 80);
      }
    });
    if (sysDigest.size !== sysSize || sysDigest.sha256.toLowerCase() !== files.sysupgrade.sha256.toLowerCase()) {
      log('永久系统回读校验失败', { expectedSize: sysSize, actualSize: sysDigest.size, expectedSha256: files.sysupgrade.sha256, actualSha256: sysDigest.sha256 });
      throw new Error(`永久系统传输校验失败（应为 ${sysSize} 字节，实际 ${sysDigest.size} 字节）。`);
    }
    const compatible = await passwordExec(targetClient, `sysupgrade -T '${sysRemote}'`, 90000);
    if (compatible.code !== 0) throw new Error('永久镜像兼容性检查失败。');
    if (!await confirm(sender, '安装永久 ImmortalWrt', '临时系统已经成功启动，永久镜像也通过兼容性和 SHA256 检查。', '继续安装')) throw new Error('已停止在临时系统，没有执行永久安装。请不要断电重启。');

    emit(4, '正在安装永久系统，请勿断电', 82);
    recoveryPlan.stage = 'permanent-install-started';
    fs.writeFileSync(path.join(sessionDir, 'recovery-plan.json'), JSON.stringify(recoveryPlan, null, 2), 'utf8');
    const upgradeStarted = await passwordExec(targetClient, `sh -c "sleep 2; sysupgrade -n '${sysRemote}' >/tmp/ax3600-sysupgrade.log 2>&1" & echo AX_SYSUPGRADE_STARTED`, 15000);
    if (upgradeStarted.code !== 0 || !upgradeStarted.stdout.includes('AX_SYSUPGRADE_STARTED')) throw new Error('永久安装命令未被临时系统接受。');
    await delay(5000);
    try { targetClient.end(); } catch { /* Router is rebooting. */ }
    targetClient = null;
    emit(5, '等待永久 ImmortalWrt 启动', 88);
    await delay(10000);
    const finalIp = await findRouter(ROUTER_TARGETS, 300, (elapsed) => emit(5, `正在重新获取网络并寻找永久系统（${elapsed} 秒）`, 88 + Math.min(8, Math.floor(elapsed / 35))));
    if (!finalIp) throw new Error(`永久系统重启后仍未在 ${ROUTER_TARGETS.join(' 或 ')} 响应。请保持供电并打开恢复说明。`);
    targetClient = await connectTarget(finalIp, 20, (attempt) => emit(5, `永久系统已发现，等待管理服务（${attempt}/20）`, 96));
    const finalBoard = await passwordExec(targetClient, 'ubus call system board; cat /etc/openwrt_release 2>/dev/null', 30000);
    if (finalBoard.code !== 0 || !/xiaomi,ax3600|Xiaomi AX3600/i.test(finalBoard.stdout) || !/ImmortalWrt/i.test(finalBoard.stdout)) throw new Error('永久系统已响应，但最终身份验证未通过。');
    const password = payload.adminPassword;
    const setPassword = `printf '%s\\n%s\\n' '${password}' '${password}' | passwd root && sync && echo AX_PASSWORD_SET`;
    const passwordResult = await passwordExec(targetClient, setPassword, 30000);
    if (passwordResult.code !== 0 || !passwordResult.stdout.includes('AX_PASSWORD_SET')) throw new Error('永久系统已启动，但设置管理密码失败。');
    try { targetClient.end(); } catch { /* Reconnect with the new password. */ }
    targetClient = await connectWithPassword(finalIp, password, 30000);
    const loginCheck = await passwordExec(targetClient, 'echo AX_FINAL_LOGIN_OK', 15000);
    if (loginCheck.code !== 0 || !loginCheck.stdout.includes('AX_FINAL_LOGIN_OK')) throw new Error('管理密码已设置，但最终登录验证失败。');
    recoveryPlan.stage = 'complete';
    recoveryPlan.managementAddress = finalIp;
    fs.writeFileSync(path.join(sessionDir, 'recovery-plan.json'), JSON.stringify(recoveryPlan, null, 2), 'utf8');
    emit(6, 'ImmortalWrt 安装完成', 100);
    log('ImmortalWrt 安装完成', { backup: sessionDir, managementAddress: finalIp });
    return { ok: true, title: 'ImmortalWrt 安装成功', message: `管理地址：http://${finalIp}\n安全备份：${sessionDir}` };
  } catch (error) {
    try { targetClient?.end(); } catch { /* Best effort only. */ }
    if (stockClient && !nandStarted) {
      try { await passwordExec(stockClient, "rm -f /tmp/ax3600_tool_key /etc/dropbear/authorized_keys /root/.ssh/authorized_keys 2>/dev/null || true; nvram set ssh_en=0; nvram commit; /etc/init.d/dropbear stop >/dev/null 2>&1 || true", 15000); } catch { /* Best effort only. */ }
      try { stockClient.end(); } catch { /* Best effort only. */ }
    } else if (stockSsh && !nandStarted) await bestEffortCleanup(stok);
    if (recoveryPlan) {
      recoveryPlan.stage = nandStarted ? `stopped-after-write: ${recoveryPlan.stage}` : 'stopped-before-write';
      recoveryPlan.lastError = String(error.message || error).slice(0, 1200);
      fs.writeFileSync(path.join(sessionDir, 'recovery-plan.json'), JSON.stringify(recoveryPlan, null, 2), 'utf8');
    }
    const message = String(error.message || error);
    if (nandStarted) throw new Error(`${message}\n\n路由器已经进入写入后的流程，请保持供电，不要反复点击；恢复记录：${path.join(sessionDir, 'recovery-plan.json')}`);
    if (/NAND 没有被写入|NAND 没有被修改/.test(message)) throw error;
    throw new Error(`${message}\n\n路由器 NAND 没有被写入。`);
  } finally {
    try { stockClient?.end(); } catch { /* Best effort only. */ }
    try { targetClient?.end(); } catch { /* Best effort only. */ }
  }
}

module.exports = { runFlash, parseStok, safePassword };
